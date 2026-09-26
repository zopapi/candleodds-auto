// The engine: one tick = fetch signals -> resolve finished windows -> decide new TAKEs ->
// (live) place / manage / convert orders. Used for live mode and for shadow mode over HTTP; the
// only difference is whether a Trader exists. All I/O is injected, so the whole lifecycle is
// unit-tested with fakes (scripts/test-engine.mjs).
//
// Order of safety, by design:
//   - a window is CLAIMED in the store before any order is placed, so a restart can never place
//     it twice; a claim that never became an order is marked failed, never retried;
//   - the same TAKE rules as the app: 10s wait, 3-minute cutoff, live-price range, maker pricing;
//   - maker first (AUTOTRADE_EXECUTION=maker_first, the default); if unfilled after
//     MAKER_FILL_TIMEOUT_SECONDS convert the REMAINDER to a taker order - but only while the price is
//     still inside the range (else the maker keeps resting). With AUTOTRADE_EXECUTION=taker there is
//     no resting order at all: a fill-and-kill order at the real best ask (fresh book read before every
//     send), capped at min(best ask + TAKER_SLIPPAGE_CENTS, ENTRY_MAX_CENTS). A fill-and-kill that fills
//     NOTHING cannot double-fill, so it is retried (max TAKER_MAX_ATTEMPTS, only within the first
//     TAKER_RETRY_WINDOW_SECONDS of the decision); after ANY fill, or any doubt, it never retries;
//   - daily trade and loss limits, a kill switch, and an immediate stop if the token is revoked.
import {
  computeOrderExpiration,
  computeTakerPrice,
  isPriceAllowed,
  MIN_GTD_EXPIRATION_SECONDS,
  roundRemainingShares,
} from "../../src/lib/trading.ts";
import { resolveOrderStatus, sumFilledSince } from "../../src/lib/order-status.ts";
import { precheck, simulatedPnlUsd, sizeDecision, type Decision } from "../decision.ts";
import { boughtSince, feeFor, planTakerAttempt, sizeTakerDecision, takerFeeUsd } from "./taker.ts";
import type { EngineConfig } from "./config.ts";
import { AuthRejected, type SignalsSource } from "./source.ts";
import type { BookLevel, Card, LegRow, MarketData, Reporter, Store, Trader, WindowRow } from "./types.ts";

export type EngineDeps = {
  cfg: EngineConfig;
  store: Store;
  market: MarketData;
  source: SignalsSource;
  reporter: Reporter;
  trader?: Trader; // present only in live mode
  nowMs: () => number;
  /** Pause between taker attempts. Injectable so tests need no real waiting; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  killSwitch: () => boolean;
  log: (msg: string, extra?: Record<string, unknown>) => void;
};

const STALE_CLAIM_MS = 60_000;
const FILL_NOW_RETRY_MS = 10_000;
const MAX_CLOCK_SKEW_SEC = 30;
const BALANCE_CACHE_MS = 15_000;
// What the exchange says when a fill-and-kill order finds nothing to match (a rejection, not a fault).
// Short pause between fill-and-kill attempts, so the next fresh book read sees a settled market.
const TAKER_RETRY_DELAY_MS = 700;
const NO_MATCH = /no orders found to match|could(?: not|n.t) be (?:fully )?filled|not (?:fully )?filled|no match/i;

export class Engine {
  private d: EngineDeps;
  private builderCode: string | undefined;
  private clockOffsetSec = 0;
  private killHandled = false;
  private haltedRemote = false;
  private resolved = new Set<string>();
  private lastFillNowAttempt = new Map<string, number>();
  private balance: { at: number; usd: number } | undefined;

  constructor(deps: EngineDeps) {
    this.d = deps;
  }

  private get live(): boolean {
    return this.d.cfg.mode === "live";
  }

  /** One pass. Never throws: every failure is logged and the next tick tries again. */
  async tick(): Promise<void> {
    try {
      await this.tickInner();
    } catch (e) {
      this.d.log("tick failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async tickInner(): Promise<void> {
    const { cfg, store, log } = this.d;

    if (this.d.killSwitch()) {
      if (!this.killHandled) {
        this.killHandled = true;
        log("KILL SWITCH ON - no new trades; cancelling resting orders");
        await this.cancelAllResting("kill_switch");
        this.d.reporter.report("event", null, null, { event: "kill_switch_on" });
      }
      return;
    }
    if (this.killHandled) {
      this.killHandled = false;
      log("kill switch off - trading resumes");
      this.d.reporter.report("event", null, null, { event: "kill_switch_off" });
    }

    let resp;
    try {
      resp = await this.d.source.fetch();
    } catch (e) {
      if (e instanceof AuthRejected) {
        if (!this.haltedRemote) {
          this.haltedRemote = true;
          log("CLIENT TOKEN REJECTED - stopping: cancelling resting orders and making no decisions until it works again", { status: e.status });
          await this.cancelAllResting("token_rejected");
          this.d.reporter.report("event", null, null, { event: "token_rejected" });
        }
        return;
      }
      throw e;
    }
    if (this.haltedRemote) {
      this.haltedRemote = false;
      log("client token accepted again - resuming");
    }
    this.builderCode = resp.builderCode;

    // Decide on the SERVER's clock: a skewed local clock would mis-time the 10s wait and the cutoff.
    const localSec = Math.floor(this.d.nowMs() / 1000);
    this.clockOffsetSec = resp.serverTime - localSec;
    if (Math.abs(this.clockOffsetSec) > MAX_CLOCK_SKEW_SEC) {
      log("local clock is far from CandleOdds' clock - making no decisions", { offsetSec: this.clockOffsetSec });
      return;
    }
    const nowSec = localSec + this.clockOffsetSec;

    // A claim that never became an order (crash mid-placement) is failed, not retried.
    if (this.live) {
      for (const w of await store.staleClaims(STALE_CLAIM_MS, this.d.nowMs())) {
        await store.updateWindow(w.symbol, w.windowStartTs, { decision: "live_failed", reason: "uncertain_after_restart" });
        log("stale claim marked failed (never retried)", { symbol: w.symbol, window: w.windowStartTs });
        this.d.reporter.report("event", w.symbol, w.windowStartTs, { event: "stale_claim_failed" });
      }
    }

    for (const card of resp.cards) {
      if (!cfg.rules.symbols.includes(card.symbol)) continue;
      try {
        await this.resolvePrevious(card);
        await this.consider(card, nowSec);
      } catch (e) {
        log("card failed", { symbol: card.symbol, error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (this.live) await this.manageLegs(nowSec);
  }

  // ---- deciding ----------------------------------------------------------------------------

  private async consider(card: Card, nowSec: number): Promise<void> {
    const { cfg, store, market } = this.d;
    const zero = { tradesToday: 0, realizedPnlUsd: 0 };
    // Taker mode gates on the REAL best ask from the live book (checked at sizing below), not on the card's
    // live price, which is a ticks MIDPOINT a few seconds old. Maker mode keeps the card-price gate.
    const gateOnCardPrice = cfg.execution !== "taker";
    const first = precheck(card, nowSec, cfg.rules, zero, cfg.range, gateOnCardPrice);
    if (first.kind === "ignore" || first.kind === "defer") return;
    if (await store.getWindow(card.symbol, card.windowStartTs)) return; // already decided

    let pre: Decision = first;
    if (first.kind === "need_book") {
      pre = precheck(card, nowSec, cfg.rules, await store.dayStats(card.windowStartTs), cfg.range, gateOnCardPrice);
    }

    let final: Decision = pre;
    let tokenId: string | undefined;
    let meta = { tickSize: 0.01, minOrderSize: 5 };
    if (pre.kind === "need_book") {
      try {
        const m = await market.forWindow(card.symbol, card.windowStartTs, card.lean!);
        tokenId = m.tokenId;
        meta = { tickSize: m.tickSize, minOrderSize: m.minOrderSize };
        const book = { tickSize: m.tickSize, minOrderSize: m.minOrderSize, asks: await market.asks(m.tokenId) };
        if (cfg.execution === "taker") {
          final = sizeTakerDecision(card, book, cfg.rules, cfg.range, cfg.takerSlippageCents);
          this.logDecisionBook(card, book);
        } else {
          final = sizeDecision(card, book, cfg.rules, cfg.range);
        }
      } catch (e) {
        // Transient: record nothing, retry next tick. If it never recovers the window ages
        // past the cutoff and is recorded as skipped:too_late.
        this.d.log("market data failed, will retry", { symbol: card.symbol, error: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    if (final.kind !== "record") return;

    const base = {
      symbol: card.symbol,
      windowStartTs: card.windowStartTs,
      mode: cfg.mode,
      lean: card.lean,
      entry: card.entry,
      currentPrice: card.currentPrice,
      stakeUsd: cfg.stakeUsd,
      tokenId: tokenId ?? null,
      decidedAtMs: this.d.nowMs(),
      execution: cfg.execution,
    };

    if (final.decision === "skipped") {
      await this.recordFinal({ ...base, decision: "skipped", reason: final.reason });
      return;
    }

    // ---- a would-place ----
    if (!this.live) {
      await this.recordFinal({ ...base, decision: "would_place", limitPrice: final.limitPrice, shares: final.shares });
      return;
    }
    await this.placeLive(card, nowSec, base, final.limitPrice, final.shares, tokenId!, meta);
  }

  /** Taker mode: the book the go/no-go decision was made from (best ask, its size, the cap), on every decision. */
  private logDecisionBook(card: Card, book: { tickSize: number; minOrderSize: number; asks: BookLevel[] }): void {
    const { cfg } = this.d;
    const plan = planTakerAttempt({ asks: book.asks, tickSize: book.tickSize, minOrderSize: book.minOrderSize, stakeUsd: cfg.stakeUsd, slippageCents: cfg.takerSlippageCents, range: cfg.range });
    const snap = plan.ok ? { bestAsk: plan.book.bestAsk, askSize: plan.book.askSize, sizeWithinCap: plan.book.sizeWithinCap, cap: plan.book.cap } : { bestAsk: plan.bestAsk, askSize: plan.askSize, cap: plan.cap, skipReason: plan.reason };
    this.d.log("TAKER BOOK (decision)", { symbol: card.symbol, window: card.windowStartTs, execution: "taker", cardMidpoint: card.currentPrice, slippageCents: cfg.takerSlippageCents, maxCents: cfg.range.maxCents, ...snap });
  }

  private async recordFinal(w: WindowRow): Promise<void> {
    if (!(await this.d.store.claimWindow(w))) return;
    this.d.log("decision", { symbol: w.symbol, window: w.windowStartTs, decision: w.decision, execution: w.execution ?? undefined, reason: w.reason ?? undefined, limitPrice: w.limitPrice ?? undefined, shares: w.shares ?? undefined });
    this.d.reporter.report("decision", w.symbol, w.windowStartTs, {
      mode: w.mode, execution: w.execution ?? null, decision: w.decision, reason: w.reason ?? null, lean: w.lean ?? null, entry: w.entry ?? null,
      currentPrice: w.currentPrice ?? null, limitPrice: w.limitPrice ?? null, shares: w.shares ?? null, stakeUsd: w.stakeUsd ?? null,
    });
  }

  private async liveBalance(): Promise<number> {
    const now = this.d.nowMs();
    if (!this.balance || now - this.balance.at > BALANCE_CACHE_MS) {
      this.balance = { at: now, usd: await this.d.trader!.balanceUsd() };
    }
    return this.balance.usd;
  }

  private async placeLive(card: Card, nowSec: number, base: Omit<WindowRow, "decision">, limitPrice: number, shares: number, tokenId: string, meta: { tickSize: number; minOrderSize: number }): Promise<void> {
    const { cfg, store, trader, market } = this.d;
    const skip = (reason: string) => this.recordFinal({ ...base, decision: "skipped", reason });

    if (!trader || !this.builderCode) return; // no builder code yet: try again next tick
    const expiry = computeOrderExpiration(nowSec, cfg.orderTtlSeconds, card.windowEndTs);
    if (!expiry.ok) return skip("window_too_close_to_end");

    // Balance, and "did this wallet already trade this window (e.g. by hand in the app)?" -
    // both checked BEFORE claiming, and a read failure means try again, never place blind.
    let balance: number;
    let activity;
    try {
      balance = await this.liveBalance();
      activity = await market.activity(trader.wallet);
    } catch (e) {
      this.d.log("pre-trade checks failed, will retry", { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (balance < cfg.stakeUsd) return skip("insufficient_balance");
    const slug = `${card.symbol}-updown-15m-${card.windowStartTs}`;
    if (activity.some((a) => a.type === "TRADE" && (a as { slug?: string }).slug === slug)) return skip("already_traded_window");

    // CLAIM first (idempotency), then place.
    const claimed = await store.claimWindow({ ...base, decision: "live_pending", limitPrice, shares });
    if (!claimed) return;

    if (cfg.execution === "taker") {
      await this.placeTaker(card, shares, tokenId, meta, base.decidedAtMs);
      return;
    }

    try {
      const res = await trader.place({ tokenId, price: limitPrice, shares, expirationSec: expiry.expiration, builderCode: this.builderCode, postOnly: true });
      const placedAtMs = this.d.nowMs();
      await store.addLeg({
        symbol: card.symbol, windowStartTs: card.windowStartTs, kind: "maker", orderId: res.orderId, tokenId,
        price: limitPrice, shares, placedAtMs, expiresAtSec: expiry.expiration, status: "resting", filledShares: 0,
      });
      await store.updateWindow(card.symbol, card.windowStartTs, { decision: "live_placed" });
      this.balance = undefined;
      this.d.log("ORDER PLACED", { symbol: card.symbol, window: card.windowStartTs, execution: "maker_first", orderId: res.orderId, limitPrice, shares });
      this.d.reporter.report("decision", card.symbol, card.windowStartTs, { mode: "live", execution: "maker_first", decision: "live_placed", lean: card.lean, entry: card.entry, currentPrice: card.currentPrice, limitPrice, shares, stakeUsd: cfg.stakeUsd });
      this.d.reporter.report("order", card.symbol, card.windowStartTs, { event: "placed", execution: "maker_first", kind: "maker", orderId: res.orderId, price: limitPrice, shares });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await store.updateWindow(card.symbol, card.windowStartTs, { decision: "live_failed", reason: `place_failed: ${msg}`.slice(0, 300) });
      this.d.log("ORDER FAILED (window not retried)", { symbol: card.symbol, window: card.windowStartTs, error: msg });
      this.d.reporter.report("event", card.symbol, card.windowStartTs, { event: "place_failed", error: msg.slice(0, 300) });
    }
  }

  /**
   * Taker execution. Each attempt reads a FRESH order book, then sends ONE fill-and-kill buy capped at
   * min(best ask + TAKER_SLIPPAGE_CENTS, ENTRY_MAX_CENTS). Whatever matches is the trade; the exchange
   * cancels the rest, so nothing ever rests.
   *
   * Retries: a fill-and-kill that fills NOTHING cannot double-fill, so it is retried - at most
   * TAKER_MAX_ATTEMPTS times, only within TAKER_RETRY_WINDOW_SECONDS of the decision, and only while the
   * ask stays inside the entry range. It NEVER retries after any fill (partial or full), after an
   * unexpected error (an order may have landed), if the public feed already shows a purchase of this
   * token, or if that feed cannot be read. The window was claimed BEFORE this call, so a restart can
   * never send it again either.
   */
  private async placeTaker(card: Card, expectedShares: number, tokenId: string, meta: { tickSize: number; minOrderSize: number }, decidedAtMs: number): Promise<void> {
    const { cfg, store, trader, market } = this.d;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const base = { symbol: card.symbol, window: card.windowStartTs, execution: "taker" as const };
    const max = cfg.takerMaxAttempts;
    let last: Record<string, unknown> = {};
    let detail = "nothing matched";
    let attempts = 0;

    for (let attempt = 1; attempt <= max; attempt++) {
      if (attempt > 1) {
        // A retry is only ever safe after a clean no-fill. Check the clock, then the public feed.
        if (this.d.nowMs() - decidedAtMs > cfg.takerRetryWindowSeconds * 1000) return this.takerNotFilled(card, "taker_no_fill", `retry window (${cfg.takerRetryWindowSeconds}s) is over: ${detail}`, attempts, last);
        await sleep(TAKER_RETRY_DELAY_MS);
        if (this.d.nowMs() - decidedAtMs > cfg.takerRetryWindowSeconds * 1000) return this.takerNotFilled(card, "taker_no_fill", `retry window (${cfg.takerRetryWindowSeconds}s) is over: ${detail}`, attempts, last);
        try {
          if (boughtSince(await market.activity(trader!.wallet), tokenId, Math.floor(decidedAtMs / 1000))) {
            return this.takerNotFilled(card, "taker_no_fill", "not retrying: the public feed already shows a purchase of this token", attempts, last);
          }
        } catch (e) {
          return this.takerNotFilled(card, "taker_no_fill", `not retrying: cannot confirm nothing was bought (${e instanceof Error ? e.message : String(e)})`, attempts, last);
        }
      }

      // 1. a FRESH book, immediately before sending
      let asks: BookLevel[];
      const bookAt = this.d.nowMs();
      try {
        asks = await market.asks(tokenId);
      } catch (e) {
        detail = `order book unavailable (${e instanceof Error ? e.message : String(e)})`;
        this.d.log("TAKER ATTEMPT SKIPPED", { ...base, attempt, of: max, reason: "book_unavailable", detail }); // nothing was sent
        continue;
      }
      const plan = planTakerAttempt({ asks, tickSize: meta.tickSize, minOrderSize: meta.minOrderSize, stakeUsd: cfg.stakeUsd, slippageCents: cfg.takerSlippageCents, range: cfg.range });

      // 2. the ask must still be inside the entry range - never chased
      if (!plan.ok) {
        const snap = { bestAsk: plan.bestAsk, askSize: plan.askSize, cap: plan.cap, maxCents: cfg.range.maxCents };
        this.d.log("TAKER ATTEMPT SKIPPED", { ...base, attempt, of: max, reason: plan.reason, ...snap });
        return this.takerNotFilled(card, plan.reason === "ask_out_of_range" ? "taker_price_moved" : "taker_no_fill", `the fresh book no longer allows a buy (${plan.reason})`, attempts, snap);
      }

      // 3. send, logging exactly what the order was based on
      const snap = { bestAsk: plan.book.bestAsk, askSize: plan.book.askSize, sizeWithinCap: plan.book.sizeWithinCap, cap: plan.book.cap };
      last = snap;
      attempts = attempt;
      this.d.log("TAKER ATTEMPT", { ...base, attempt, of: max, ...snap, slippageCents: cfg.takerSlippageCents, maxCents: cfg.range.maxCents, bookAgeMs: this.d.nowMs() - bookAt, requestedShares: expectedShares });
      this.d.reporter.report("order", card.symbol, card.windowStartTs, { event: "taker_attempt", execution: "taker", attempt, of: max, ...snap });
      try {
        const res = await trader!.marketBuy({ tokenId, amountUsd: cfg.stakeUsd, maxPrice: plan.book.cap, builderCode: this.builderCode! });
        this.balance = undefined;
        if (res.shares > 0) return await this.takerFilled(card, tokenId, res, plan.book.cap, attempt, expectedShares, snap); // any fill: done, NEVER retried
        detail = "the order was accepted but nothing matched";
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!NO_MATCH.test(msg)) {
          // Not the exchange's clean "nothing to match": the order may or may not have landed. Never retry.
          await store.updateWindow(card.symbol, card.windowStartTs, { decision: "live_failed", reason: `place_failed: ${msg}`.slice(0, 300) });
          this.d.log("TAKER ORDER FAILED (window not retried)", { ...base, attempt, ...snap, error: msg });
          this.d.reporter.report("event", card.symbol, card.windowStartTs, { event: "place_failed", execution: "taker", attempt, error: msg.slice(0, 300) });
          return;
        }
        detail = msg.slice(0, 200);
      }
      this.d.log("TAKER ATTEMPT NOT FILLED", { ...base, attempt, of: max, ...snap, detail });
    }
    return this.takerNotFilled(card, "taker_no_fill", detail, attempts, last);
  }

  private async takerFilled(card: Card, tokenId: string, res: { orderId: string; spentUsd: number; shares: number; txHashes: string[] }, cap: number, attempt: number, expectedShares: number, snap: Record<string, unknown>): Promise<void> {
    const { cfg, store } = this.d;
    const fillPrice = Math.round((res.spentUsd / res.shares) * 1e6) / 1e6;
    const feeUsd = feeFor("taker", res.shares, fillPrice);
    await store.addLeg({
      symbol: card.symbol, windowStartTs: card.windowStartTs, kind: "taker", orderId: res.orderId, tokenId, price: fillPrice, shares: res.shares,
      placedAtMs: this.d.nowMs(), expiresAtSec: card.windowEndTs, status: "filled", filledShares: res.shares,
    });
    await store.updateWindow(card.symbol, card.windowStartTs, { decision: "live_placed", execution: "taker", limitPrice: cap, shares: res.shares, fillPrice, feeUsd });
    this.d.log("TAKER ORDER FILLED", { symbol: card.symbol, window: card.windowStartTs, execution: "taker", attempt, orderId: res.orderId, fillPrice, shares: res.shares, requestedShares: expectedShares, spentUsd: res.spentUsd, feeUsd, allInUsd: Math.round((res.spentUsd + feeUsd) * 1e6) / 1e6, feeSource: "polymarket_formula_estimate", ...snap, txHashes: res.txHashes });
    this.d.reporter.report("decision", card.symbol, card.windowStartTs, { mode: "live", execution: "taker", decision: "live_placed", lean: card.lean, entry: card.entry, currentPrice: card.currentPrice, limitPrice: cap, shares: res.shares, stakeUsd: cfg.stakeUsd, fillPrice, feeUsd });
    this.d.reporter.report("order", card.symbol, card.windowStartTs, { event: "filled", execution: "taker", kind: "taker", attempt, orderId: res.orderId, price: fillPrice, shares: res.shares, filled: res.shares, spentUsd: res.spentUsd, feeUsd, allInUsd: Math.round((res.spentUsd + feeUsd) * 1e6) / 1e6, feeSource: "polymarket_formula_estimate", ...snap });
  }

  private async takerNotFilled(card: Card, reason: string, detail: string, attempts: number, snap: Record<string, unknown>): Promise<void> {
    await this.d.store.updateWindow(card.symbol, card.windowStartTs, { decision: "live_failed", reason, execution: "taker" });
    this.d.log("TAKER ORDER NOT FILLED (window not retried)", { symbol: card.symbol, window: card.windowStartTs, execution: "taker", reason, attempts, of: this.d.cfg.takerMaxAttempts, detail, ...snap });
    this.d.reporter.report("event", card.symbol, card.windowStartTs, { event: "taker_no_fill", execution: "taker", reason, attempts, detail, ...snap });
  }

  // ---- managing open orders ---------------------------------------------------------------------

  private async manageLegs(nowSec: number): Promise<void> {
    const { store, market, trader } = this.d;
    const legs = await store.openLegs();
    if (legs.length === 0 || !trader) return;
    const activity = await market.activity(trader.wallet);

    for (const leg of legs) {
      const r = resolveOrderStatus(
        { shares: leg.shares, limitPrice: leg.price, placedAt: leg.placedAtMs, expiresAt: leg.expiresAtSec, status: "resting", tokenId: leg.tokenId },
        activity,
        nowSec,
      );
      if (r.status !== "resting" || r.filledShares !== leg.filledShares) {
        await store.updateLeg(leg.orderId, { status: r.status, filledShares: r.filledShares });
        const label = r.status === "filled" ? "ORDER FILLED" : r.status === "expired" ? "ORDER EXPIRED" : "ORDER PARTIAL FILL";
        const feeUsd = feeFor(leg.kind, r.filledShares, leg.price);
        this.d.log(label, { symbol: leg.symbol, window: leg.windowStartTs, execution: "maker_first", kind: leg.kind, orderId: leg.orderId, price: leg.price, filled: r.filledShares, of: leg.shares, fillPrice: leg.price, feeUsd });
        if (r.status !== "resting") {
          this.d.reporter.report("order", leg.symbol, leg.windowStartTs, { event: r.status, execution: "maker_first", kind: leg.kind, orderId: leg.orderId, price: leg.price, shares: leg.shares, filled: r.filledShares, fillPrice: leg.price, feeUsd });
        }
      }
      const restingMs = this.d.nowMs() - leg.placedAtMs;
      if (leg.kind === "maker" && r.status === "resting" && restingMs >= this.d.cfg.makerFillTimeoutSeconds * 1000) {
        const last = this.lastFillNowAttempt.get(leg.orderId) ?? 0;
        if (this.d.nowMs() - last >= FILL_NOW_RETRY_MS) {
          this.lastFillNowAttempt.set(leg.orderId, this.d.nowMs());
          try {
            await this.fillNow(leg, r.filledShares, nowSec);
          } catch (e) {
            this.d.log("fill-now failed", { orderId: leg.orderId, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    }
  }

  /**
   * The maker order rested unfilled past the timeout: buy the REMAINDER as a taker order at the
   * current best price - but only while that price is still inside the allowed range. The price
   * is checked BEFORE cancelling, so if the market has moved out of range the maker simply
   * keeps resting (it may still fill) instead of being cancelled for nothing.
   */
  private async fillNow(leg: LegRow, knownFilled: number, nowSec: number): Promise<void> {
    const { cfg, store, market, trader } = this.d;
    if (!trader || !this.builderCode) return;
    const w = await store.getWindow(leg.symbol, leg.windowStartTs);
    if (!w?.lean) return;
    const m = await market.forWindow(leg.symbol, leg.windowStartTs, w.lean);

    const quote = async (remaining: number) =>
      computeTakerPrice({ tickSize: m.tickSize, minOrderSize: m.minOrderSize, asks: await market.asks(leg.tokenId), remainingShares: remaining });

    const estimate = roundRemainingShares(leg.shares - knownFilled);
    if (estimate <= 0) return;
    const pre = await quote(estimate);
    if (!pre.ok || !isPriceAllowed(pre.limitPrice, cfg.range)) return; // price moved: leave the maker resting

    // Commit: cancel the maker. Only a CONFIRMED cancel lets us buy the remainder - otherwise the
    // order probably just filled/expired, and buying again would double up.
    if (!(await trader.cancel(leg.orderId))) {
      this.d.reporter.report("event", leg.symbol, leg.windowStartTs, { event: "fill_now_cancel_unconfirmed", orderId: leg.orderId });
      return;
    }
    await store.updateLeg(leg.orderId, { status: "cancelled" });

    // The freshest possible filled amount for the leg just cancelled.
    const filled = Math.min(sumFilledSince(await market.activity(trader.wallet), leg.tokenId, leg.price, Math.floor(leg.placedAtMs / 1000)), leg.shares);
    await store.updateLeg(leg.orderId, { filledShares: filled });
    const remaining = roundRemainingShares(leg.shares - filled);
    if (remaining <= 0) return; // filled in the instant before the cancel landed

    const taker = await quote(remaining);
    if (!taker.ok || !isPriceAllowed(taker.limitPrice, cfg.range)) {
      this.d.reporter.report("event", leg.symbol, leg.windowStartTs, { event: "fill_now_abandoned", reason: taker.ok ? "price_out_of_range" : "no_taker_price", filled });
      return;
    }
    const expiry = computeOrderExpiration(nowSec, MIN_GTD_EXPIRATION_SECONDS, leg.expiresAtSec);
    if (!expiry.ok) {
      this.d.reporter.report("event", leg.symbol, leg.windowStartTs, { event: "fill_now_abandoned", reason: "too_close_to_window_end", filled });
      return;
    }

    const res = await trader.place({ tokenId: leg.tokenId, price: taker.limitPrice, shares: taker.shares, expirationSec: expiry.expiration, builderCode: this.builderCode, postOnly: false });
    await store.addLeg({
      symbol: leg.symbol, windowStartTs: leg.windowStartTs, kind: "taker", orderId: res.orderId, tokenId: leg.tokenId,
      price: taker.limitPrice, shares: taker.shares, placedAtMs: this.d.nowMs(), expiresAtSec: expiry.expiration, status: "resting", filledShares: 0,
    });
    this.balance = undefined;
    this.d.log("FILL NOW: converted remainder to a taker order", { symbol: leg.symbol, window: leg.windowStartTs, remaining: taker.shares, price: taker.limitPrice });
    this.d.reporter.report("order", leg.symbol, leg.windowStartTs, { event: "converted", execution: "maker_first", kind: "taker", orderId: res.orderId, price: taker.limitPrice, shares: taker.shares, carried: filled });
  }

  /** Cancels every resting order (kill switch / revoked token). Only confirmed cancels are recorded. */
  async cancelAllResting(reason: string): Promise<void> {
    const { store, trader } = this.d;
    if (!trader) return;
    for (const leg of await store.openLegs()) {
      try {
        if (await trader.cancel(leg.orderId)) {
          await store.updateLeg(leg.orderId, { status: "cancelled" });
          this.d.reporter.report("order", leg.symbol, leg.windowStartTs, { event: "cancelled", reason, kind: leg.kind, orderId: leg.orderId });
        }
      } catch (e) {
        this.d.log("cancel failed", { orderId: leg.orderId, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // ---- results ----------------------------------------------------------------------------------

  /** When the next window's card says the previous one resolved, record the result and P&L. */
  private async resolvePrevious(card: Card): Promise<void> {
    if (!card.prevResolved || card.prevWin === null || card.prevWindowStartTs === null) return;
    const key = `${card.symbol}:${card.prevWindowStartTs}`;
    if (this.resolved.has(key)) return;
    const { store, market, trader } = this.d;
    const w = await store.unresolvedWindow(card.symbol, card.prevWindowStartTs);
    if (!w) {
      this.resolved.add(key);
      return;
    }

    let pnl: number;
    if (w.execution === "taker") {
      // A taker window is one immediate fill: P&L comes from what was actually paid (live) or from the
      // ask it would have hit (shadow), less the taker fee - so it is comparable with a maker window.
      const price = w.fillPrice ?? w.limitPrice ?? null;
      const shares = w.shares ?? null;
      const fee = w.feeUsd ?? (price !== null && shares !== null ? takerFeeUsd(shares, price) : 0);
      pnl = price !== null && shares !== null ? simulatedPnlUsd(price, shares, card.prevWin) - fee : 0;
    } else if (this.live && trader) {
      const legs = await store.legsFor(card.symbol, card.prevWindowStartTs);
      const activity = await market.activity(trader.wallet);
      pnl = 0;
      for (const leg of legs) {
        const filled = Math.min(sumFilledSince(activity, leg.tokenId, leg.price, Math.floor(leg.placedAtMs / 1000)), leg.shares);
        await store.updateLeg(leg.orderId, { filledShares: filled, ...(leg.status === "resting" ? { status: "expired" as const } : {}) });
        pnl += filled > 0 ? simulatedPnlUsd(leg.price, filled, card.prevWin) : 0;
      }
    } else {
      pnl = w.limitPrice != null && w.shares != null ? simulatedPnlUsd(w.limitPrice, w.shares, card.prevWin) : 0;
    }
    pnl = Math.round(pnl * 1e6) / 1e6;
    await store.updateWindow(card.symbol, card.prevWindowStartTs, { outcomeWin: card.prevWin, pnlUsd: pnl });
    this.resolved.add(key);
    this.d.log("resolved", { symbol: card.symbol, window: card.prevWindowStartTs, win: card.prevWin, pnlUsd: pnl });
    this.d.reporter.report("event", card.symbol, card.prevWindowStartTs, { event: "resolved", win: card.prevWin, pnlUsd: pnl, mode: this.d.cfg.mode });
  }
}
