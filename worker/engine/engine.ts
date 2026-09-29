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
//   - taker re-entry: if the ask is ABOVE the range at decision time (the price ran in the signal's favour), nothing is
//     recorded yet - the window is watched on every tick until AUTOTRADE_REENTRY_UNTIL_SECONDS after open and bought
//     the first time the ask is back inside the range (same claim-then-place, so still one trade per window). Limits
//     are re-read on every look; a revoked signal, the kill switch or a rejected token ends the watch;
//   - taker watch (v1.0.2): a window that ends its first burst short of the stake (nothing matched, the ask left the
//     range, or a partial fill) is watched until AUTOTRADE_REENTRY_UNTIL_SECONDS and the rest bought when the ask is
//     back in range - never more than the stake, never after a purchase it did not make itself, never after a restart;
//   - daily trade and loss limits, a kill switch, and an immediate stop if the token is revoked.
import {
  bestAskOf,
  computeOrderExpiration,
  computeTakerPrice,
  isPriceAllowed,
  MIN_GTD_EXPIRATION_SECONDS,
  roundRemainingShares,
} from "../../src/lib/trading.ts";
import { resolveOrderStatus, sumFilledSince } from "../../src/lib/order-status.ts";
import { precheck, simulatedPnlUsd, sizeDecision, type Decision } from "../decision.ts";
import { feeFor, planTakerAttempt, sizeAtOrBelow, sizeTakerDecision, takerFeeUsd, topOfBook, unknownPurchaseShares } from "./taker.ts";
import type { EngineConfig } from "./config.ts";
import { AuthRejected, type SignalsSource } from "./source.ts";
import type { BookLevel, Card, LegRow, MarketBuyResult, MarketData, Reporter, Store, Trader, WindowRow } from "./types.ts";

type Meta = { tickSize: number; minOrderSize: number };
/** A taker window being bought: what the window has bought so far, and its sends. */
type TakerProgress = {
  tokenId: string;
  meta: Meta;
  /** When the window was decided; the public feed is checked for purchases since then. */
  decidedAtMs: number;
  spentUsd: number;
  feeUsd: number;
  shares: number;
  /** Fill-and-kill orders sent for this window so far (burst and watch). */
  sends: number;
  lastSendMs: number;
  /** The cap of the last fill (the price the "is anything left worth buying" check uses). */
  lastCap: number;
};
type AttemptResult =
  | { kind: "filled"; snap: Record<string, unknown> }
  | { kind: "no_match"; snap: Record<string, unknown>; detail: string; why: string }
  | { kind: "error"; snap: Record<string, unknown> }
  | { kind: "book_unavailable"; detail: string; snap?: undefined }
  | { kind: "no_liquidity" | "ask_out_of_range" | "below_min_order_size"; snap: Record<string, unknown> };
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

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
// A watched taker window: at most one send per this gap, and this many sends per window in all (burst included).
const TAKER_WATCH_GAP_MS = 5_000;
const TAKER_MAX_SENDS_PER_WINDOW = 12;
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
  /** Taker re-entry: windows whose ask was ABOVE the entry range at decision time, being watched (nothing recorded
   * yet) until cfg.reentryUntilSeconds after open. In memory only: after a restart such a window is past the normal
   * cutoff and is recorded as too_late, so a restart can never trade it twice. */
  private reentry = new Map<string, { sinceSec: number }>();
  /** Taker windows short of their stake after the first burst (nothing matched, the ask left the range, or a partial
   * fill), watched until cfg.reentryUntilSeconds after open. In memory only: a restart forgets them, and a window is
   * never sent again after a restart. */
  private building = new Map<string, TakerProgress>();

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
        this.dropReentries("kill_switch");
        this.dropTakerWatches("kill_switch");
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
          this.dropReentries("token_rejected");
          this.dropTakerWatches("token_rejected");
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
    // A watched window whose 15 minutes are over (e.g. its card was never seen again) is forgotten.
    for (const k of this.reentry.keys()) if (nowSec - Number(k.split(":")[1]) > 900) this.reentry.delete(k);
    for (const k of this.building.keys()) if (nowSec - Number(k.split(":")[1]) > 900) this.building.delete(k);

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
    const key = `${card.symbol}:${card.windowStartTs}`;
    // A taker window short of its stake: look at it again (it was decided already; see placeTaker).
    const building = this.building.get(key);
    if (building) {
      if (this.live) await this.continueTaker(card, nowSec, building);
      return;
    }
    const waiting = this.reentry.get(key);
    // A window being watched for re-entry may be decided up to reentryUntilSeconds after open (not the normal cutoff).
    const rules = waiting ? { ...cfg.rules, maxAgeSeconds: Math.max(cfg.rules.maxAgeSeconds, cfg.reentryUntilSeconds) } : cfg.rules;
    const first = precheck(card, nowSec, rules, zero, cfg.range, gateOnCardPrice);
    if (first.kind === "ignore") {
      // The TAKE is gone from the card (revoked): stop watching; nothing was ever recorded or placed.
      if (waiting) this.endReentry(card, "signal_revoked", nowSec);
      return;
    }
    if (first.kind === "defer") return;
    if (await store.getWindow(card.symbol, card.windowStartTs)) {
      this.reentry.delete(key);
      return; // already decided
    }
    if (waiting && first.kind === "record" && first.decision === "skipped" && first.reason === "too_late") {
      this.endReentry(card, "reentry_expired", nowSec);
      await this.recordFinal({
        symbol: card.symbol, windowStartTs: card.windowStartTs, mode: cfg.mode, lean: card.lean, entry: card.entry, currentPrice: card.currentPrice,
        stakeUsd: cfg.stakeUsd, tokenId: null, decidedAtMs: this.d.nowMs(), execution: cfg.execution, decision: "skipped", reason: "reentry_expired",
      });
      return;
    }

    let pre: Decision = first;
    if (first.kind === "need_book") {
      // Limits are re-read on every look, so a watched window respects a trade cap or loss limit reached meanwhile.
      pre = precheck(card, nowSec, rules, await store.dayStats(card.windowStartTs), cfg.range, gateOnCardPrice);
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
          const plan = planTakerAttempt({ asks: book.asks, tickSize: book.tickSize, minOrderSize: book.minOrderSize, stakeUsd: cfg.stakeUsd, slippageCents: cfg.takerSlippageCents, range: cfg.range });
          const outOfRange = !plan.ok && plan.reason === "ask_out_of_range";
          const above = outOfRange && plan.bestAsk !== undefined && plan.bestAsk * 100 > cfg.range.maxCents + 1e-9;
          const ageSec = nowSec - card.windowStartTs;
          // Re-entry: an ask ABOVE the range starts a watch; once watching, any out-of-range ask keeps it going.
          if ((waiting ? outOfRange : above) && ageSec < cfg.reentryUntilSeconds) {
            if (!waiting) this.startReentry(card, nowSec, plan.ok ? undefined : plan.bestAsk, book);
            return; // nothing recorded: look again on the next tick
          }
          final = sizeTakerDecision(card, book, cfg.rules, cfg.range, cfg.takerSlippageCents);
          this.logDecisionBook(card, book);
          if (waiting) {
            this.reentry.delete(key);
            if (final.kind === "record" && final.decision === "would_place") {
              this.d.log("RE-ENTRY: ask back inside the entry range", { symbol: card.symbol, window: card.windowStartTs, afterSec: ageSec, watchedSec: nowSec - waiting.sinceSec, bestAsk: final.bestAsk, cap: final.limitPrice, maxCents: cfg.range.maxCents });
              this.d.reporter.report("event", card.symbol, card.windowStartTs, { event: "reentry_entry", afterSec: ageSec, bestAsk: final.bestAsk ?? null, cap: final.limitPrice });
            }
          }
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

  private startReentry(card: Card, nowSec: number, bestAsk: number | undefined, book: { tickSize: number; minOrderSize: number; asks: BookLevel[] }): void {
    const { cfg } = this.d;
    this.reentry.set(`${card.symbol}:${card.windowStartTs}`, { sinceSec: nowSec });
    this.logDecisionBook(card, book);
    this.d.log("RE-ENTRY WAIT: ask above the entry range - watching for it to come back", { symbol: card.symbol, window: card.windowStartTs, ageSec: nowSec - card.windowStartTs, bestAsk, maxCents: cfg.range.maxCents, untilSec: cfg.reentryUntilSeconds });
    this.d.reporter.report("event", card.symbol, card.windowStartTs, { event: "reentry_wait", ageSec: nowSec - card.windowStartTs, bestAsk: bestAsk ?? null, maxCents: cfg.range.maxCents, untilSec: cfg.reentryUntilSeconds });
  }

  private endReentry(card: Card, reason: "signal_revoked" | "reentry_expired", nowSec: number): void {
    const key = `${card.symbol}:${card.windowStartTs}`;
    const w = this.reentry.get(key);
    this.reentry.delete(key);
    this.d.log(reason === "reentry_expired" ? "RE-ENTRY WINDOW OVER: the ask never came back inside the range" : "RE-ENTRY STOPPED: the signal was revoked", { symbol: card.symbol, window: card.windowStartTs, ageSec: nowSec - card.windowStartTs, watchedSec: w ? nowSec - w.sinceSec : undefined });
    if (reason === "signal_revoked") this.d.reporter.report("event", card.symbol, card.windowStartTs, { event: "reentry_revoked" });
  }

  /** Drops every re-entry watch (kill switch, revoked token): nothing was ever placed for them. */
  private dropReentries(why: string): void {
    if (this.reentry.size === 0) return;
    this.d.log("re-entry watches dropped", { why, windows: [...this.reentry.keys()] });
    this.reentry.clear();
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
      await this.placeTaker(card, tokenId, meta, base.decidedAtMs);
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

  // ---- taker execution ------------------------------------------------------------------------------

  /**
   * Taker execution. Each attempt reads a FRESH order book, then sends ONE fill-and-kill buy for what is left of the
   * stake, capped at min(best ask + TAKER_SLIPPAGE_CENTS, ENTRY_MAX_CENTS). Whatever matches is bought; the exchange
   * cancels the rest, so nothing ever rests. The stake is the most the window ever buys: still one position per window.
   *
   * The first burst: at most TAKER_MAX_ATTEMPTS sends, only within TAKER_RETRY_WINDOW_SECONDS of the decision, and only
   * while the ask stays inside the entry range. A no-match is retried (a fill-and-kill that matched nothing cannot
   * double-fill); a partial fill is followed by a send for the remainder.
   *
   * If the burst ends short of the stake (nothing matched, the ask left the range, or only part filled), the window is
   * WATCHED on every tick until AUTOTRADE_REENTRY_UNTIL_SECONDS after open, and the rest is bought the first time the ask
   * is back in range: at most one send every TAKER_WATCH_GAP_MS, TAKER_MAX_SENDS_PER_WINDOW in all. The watch is in
   * memory only, so a restart forgets it and never sends the window again.
   *
   * Before every send after the first, the public feed must show no purchase of this token beyond what this engine
   * bought itself (e.g. one made by hand in the app); if it does, the window is left alone for good. So is a window
   * whose send failed with an unexpected error (the order may or may not have landed).
   */
  private async placeTaker(card: Card, tokenId: string, meta: Meta, decidedAtMs: number): Promise<void> {
    const { cfg } = this.d;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const p: TakerProgress = { tokenId, meta, decidedAtMs, spentUsd: 0, feeUsd: 0, shares: 0, sends: 0, lastSendMs: 0, lastCap: cfg.range.maxCents / 100 };
    const max = cfg.takerMaxAttempts;
    const retryOver = () => this.d.nowMs() - decidedAtMs > cfg.takerRetryWindowSeconds * 1000;
    let detail = "nothing matched";
    let why: string | undefined;
    let last: Record<string, unknown> = {};
    let end: "complete" | "no_fill" | "price_moved" | "stop" = "no_fill";

    for (let attempt = 1; attempt <= max; attempt++) {
      if (attempt > 1) {
        // A further send is only ever safe after a clean result. Check the clock, then the public feed.
        if (retryOver()) { detail = `retry window (${cfg.takerRetryWindowSeconds}s) is over: ${detail}`; break; }
        await sleep(TAKER_RETRY_DELAY_MS);
        if (retryOver()) { detail = `retry window (${cfg.takerRetryWindowSeconds}s) is over: ${detail}`; break; }
        const check = await this.purchaseCheck(p);
        if (check.state === "unknown_purchase") { detail = "not retrying: the public feed already shows a purchase of this token"; end = "stop"; break; }
        if (check.state === "unreadable") { detail = `not retrying: cannot confirm nothing was bought (${check.error})`; break; }
      }

      const r = await this.takerAttempt(card, p, attempt, max, false);
      if (r.snap) last = r.snap;
      if (r.kind === "error") return; // recorded by takerAttempt: never retried, never watched
      if (r.kind === "filled") {
        if (this.remainderDone(p)) { end = "complete"; break; }
        detail = "partly filled";
        continue;
      }
      if (r.kind === "no_match") { detail = r.detail; why = r.why; continue; }
      if (r.kind === "book_unavailable") { detail = r.detail; continue; }
      if (r.kind === "below_min_order_size" && p.shares > 0) { end = "complete"; break; }
      end = r.kind === "ask_out_of_range" ? "price_moved" : "no_fill";
      detail = `the fresh book no longer allows a buy (${r.kind})`;
      break;
    }

    if (end === "complete") return;
    if (p.shares === 0) await this.takerNotFilled(card, end === "price_moved" ? "taker_price_moved" : "taker_no_fill", detail, p.sends, last, why);
    if (end !== "stop") this.startTakerWatch(card, p, p.shares > 0 ? "remainder" : "no_fill");
  }

  /**
   * One send from a fresh book (or none, if the book no longer allows a buy). `quiet` drops the "skipped" log line:
   * a watched window looks at the book on every tick, and an ask outside the range is expected there, not news.
   */
  private async takerAttempt(card: Card, p: TakerProgress, attempt: number, of: number, quiet: boolean): Promise<AttemptResult> {
    const { cfg, store, market, trader } = this.d;
    const base = { symbol: card.symbol, window: card.windowStartTs, execution: "taker" as const };

    // 1. a FRESH book, immediately before sending
    const bookAt = this.d.nowMs();
    let asks: BookLevel[];
    try {
      asks = await market.asks(p.tokenId);
    } catch (e) {
      const detail = `order book unavailable (${e instanceof Error ? e.message : String(e)})`;
      if (!quiet) this.d.log("TAKER ATTEMPT SKIPPED", { ...base, attempt, of, reason: "book_unavailable", detail }); // nothing was sent
      return { kind: "book_unavailable", detail };
    }
    const remainingUsd = this.remainingUsd(p);
    const plan = planTakerAttempt({ asks, tickSize: p.meta.tickSize, minOrderSize: p.meta.minOrderSize, stakeUsd: remainingUsd, slippageCents: cfg.takerSlippageCents, range: cfg.range });

    // 2. the ask must still be inside the entry range - never chased
    if (!plan.ok) {
      const snap = { bestAsk: plan.bestAsk, askSize: plan.askSize, cap: plan.cap, maxCents: cfg.range.maxCents };
      if (!quiet) this.d.log("TAKER ATTEMPT SKIPPED", { ...base, attempt, of, reason: plan.reason, ...snap });
      return { kind: plan.reason, snap };
    }

    // 3. send, logging exactly what the order was based on
    const snap = { bestAsk: plan.book.bestAsk, askSize: plan.book.askSize, sizeWithinCap: plan.book.sizeWithinCap, cap: plan.book.cap };
    const topUp = p.shares > 0;
    p.sends += 1;
    p.lastSendMs = this.d.nowMs();
    this.d.log("TAKER ATTEMPT", { ...base, attempt, of, ...snap, slippageCents: cfg.takerSlippageCents, maxCents: cfg.range.maxCents, bookAgeMs: this.d.nowMs() - bookAt, requestedUsd: remainingUsd, requestedShares: plan.shares, ...(topUp ? { topUp } : {}) });
    this.d.reporter.report("order", card.symbol, card.windowStartTs, { event: "taker_attempt", execution: "taker", attempt, of, ...snap, ...(topUp ? { topUp, requestedUsd: remainingUsd } : {}) });
    let exchange: string;
    try {
      const res = await trader!.marketBuy({ tokenId: p.tokenId, amountUsd: remainingUsd, maxPrice: plan.book.cap, builderCode: this.builderCode! });
      this.balance = undefined;
      if (res.shares > 0) {
        await this.recordTakerFill(card, p, res, plan.book.cap, attempt, snap);
        return { kind: "filled", snap };
      }
      exchange = "the order was accepted but nothing matched";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!NO_MATCH.test(msg)) {
        // Not the exchange's clean "nothing to match": the order may or may not have landed. Never sent again.
        if (p.shares === 0) await store.updateWindow(card.symbol, card.windowStartTs, { decision: "live_failed", reason: `place_failed: ${msg}`.slice(0, 300) });
        this.d.log("TAKER ORDER FAILED (window not retried)", { ...base, attempt, ...snap, error: msg });
        this.d.reporter.report("event", card.symbol, card.windowStartTs, { event: "place_failed", execution: "taker", attempt, error: msg.slice(0, 300) });
        return { kind: "error", snap };
      }
      exchange = msg.slice(0, 200);
    }
    const why = await this.explainNoMatch(card, p, attempt, of, asks, snap, exchange);
    return { kind: "no_match", snap, detail: exchange, why };
  }

  /**
   * An attempt matched nothing: read the book once more and say why, next to the book the order was sent from.
   *   ask_moved_above_cap        - the best ask was above the cap by the time we looked again (the market ran);
   *   nothing_matched_within_cap - an ask at or below the cap is still there (the liquidity we saw was taken or
   *                                pulled as the order landed, or the exchange refused the match);
   *   book_empty_after / book_unreadable_after - no asks at all / the book couldn't be read.
   */
  private async explainNoMatch(card: Card, p: TakerProgress, attempt: number, of: number, sentFrom: BookLevel[], snap: { bestAsk: number; askSize?: number; sizeWithinCap?: number; cap: number }, exchange: string): Promise<string> {
    let after: BookLevel[] | undefined;
    try {
      after = await this.d.market.asks(p.tokenId);
    } catch {
      after = undefined;
    }
    const askAfter = after ? bestAskOf(after) : undefined;
    const why = !after ? "book_unreadable_after" : askAfter === undefined ? "book_empty_after" : askAfter > snap.cap + 1e-9 ? "ask_moved_above_cap" : "nothing_matched_within_cap";
    const info = {
      attempt, of, ...snap, depth: topOfBook(sentFrom),
      askAfter: askAfter ?? null, sizeWithinCapAfter: after ? sizeAtOrBelow(after, snap.cap) ?? null : null, depthAfter: after ? topOfBook(after) : null,
      exchange, why,
    };
    this.d.log("TAKER ATTEMPT NOT FILLED", { symbol: card.symbol, window: card.windowStartTs, execution: "taker", ...info, detail: exchange });
    this.d.reporter.report("event", card.symbol, card.windowStartTs, { event: "taker_attempt_no_match", execution: "taker", ...info });
    return why;
  }

  /** A fill (full or partial) of one send: stored as a finished taker leg, and the window's totals updated. */
  private async recordTakerFill(card: Card, p: TakerProgress, res: MarketBuyResult, cap: number, attempt: number, snap: Record<string, unknown>): Promise<void> {
    const { cfg, store } = this.d;
    const first = p.shares === 0;
    const fillPrice = r6(res.spentUsd / res.shares);
    const feeUsd = feeFor("taker", res.shares, fillPrice);
    p.spentUsd = r6(p.spentUsd + res.spentUsd);
    p.feeUsd = r6(p.feeUsd + feeUsd);
    p.shares = r6(p.shares + res.shares);
    p.lastCap = cap;
    const avgPrice = r6(p.spentUsd / p.shares);
    const allInUsd = r6(res.spentUsd + feeUsd);
    await store.addLeg({
      symbol: card.symbol, windowStartTs: card.windowStartTs, kind: "taker", orderId: res.orderId, tokenId: p.tokenId, price: fillPrice, shares: res.shares,
      placedAtMs: this.d.nowMs(), expiresAtSec: card.windowEndTs, status: "filled", filledShares: res.shares,
    });
    // The window holds the totals: shares bought, the average price paid, the fees - what P&L is computed from.
    await store.updateWindow(card.symbol, card.windowStartTs, { decision: "live_placed", reason: null, execution: "taker", limitPrice: cap, shares: p.shares, fillPrice: avgPrice, feeUsd: p.feeUsd });
    const totals = { topUp: !first, totalShares: p.shares, totalSpentUsd: p.spentUsd, avgPrice, remainingUsd: this.remainingUsd(p) };
    this.d.log("TAKER ORDER FILLED", { symbol: card.symbol, window: card.windowStartTs, execution: "taker", attempt, orderId: res.orderId, fillPrice, shares: res.shares, spentUsd: res.spentUsd, feeUsd, allInUsd, feeSource: "polymarket_formula_estimate", ...snap, txHashes: res.txHashes, ...totals });
    if (first) {
      this.d.reporter.report("decision", card.symbol, card.windowStartTs, { mode: "live", execution: "taker", decision: "live_placed", lean: card.lean, entry: card.entry, currentPrice: card.currentPrice, limitPrice: cap, shares: res.shares, stakeUsd: cfg.stakeUsd, fillPrice, feeUsd });
    }
    this.d.reporter.report("order", card.symbol, card.windowStartTs, { event: "filled", execution: "taker", kind: "taker", attempt, orderId: res.orderId, price: fillPrice, shares: res.shares, filled: res.shares, spentUsd: res.spentUsd, feeUsd, allInUsd, feeSource: "polymarket_formula_estimate", ...snap, ...totals });
  }

  /** Nothing bought yet and the window is given up (for now): recorded live_failed with the reason. */
  private async takerNotFilled(card: Card, reason: string, detail: string, attempts: number, snap: Record<string, unknown>, why?: string): Promise<void> {
    await this.d.store.updateWindow(card.symbol, card.windowStartTs, { decision: "live_failed", reason, execution: "taker" });
    this.d.log("TAKER ORDER NOT FILLED", { symbol: card.symbol, window: card.windowStartTs, execution: "taker", reason, attempts, of: this.d.cfg.takerMaxAttempts, detail, ...(why ? { why } : {}), ...snap });
    this.d.reporter.report("event", card.symbol, card.windowStartTs, { event: "taker_no_fill", execution: "taker", reason, attempts, detail, ...(why ? { why } : {}), ...snap });
  }

  /** What is left of the stake to spend (fees included), in whole cents. */
  private remainingUsd(p: TakerProgress): number {
    return Math.max(0, Math.floor((this.d.cfg.stakeUsd - p.spentUsd - p.feeUsd) * 100 + 1e-9) / 100);
  }

  /** The stake is used up: what's left couldn't buy the market's minimum order at the last cap. */
  private remainderDone(p: TakerProgress): boolean {
    return Math.floor((this.remainingUsd(p) / p.lastCap) * 100 + 1e-9) / 100 < p.meta.minOrderSize;
  }

  /** Does the public feed show a purchase of this token (since the decision) beyond what this engine bought itself? */
  private async purchaseCheck(p: TakerProgress): Promise<{ state: "ok" | "unknown_purchase" } | { state: "unreadable"; error: string }> {
    try {
      const activity = await this.d.market.activity(this.d.trader!.wallet);
      return { state: unknownPurchaseShares(activity, p.tokenId, Math.floor(p.decidedAtMs / 1000), p.shares) > 0 ? "unknown_purchase" : "ok" };
    } catch (e) {
      return { state: "unreadable", error: e instanceof Error ? e.message : String(e) };
    }
  }

  private serverNowSec(): number {
    return Math.floor(this.d.nowMs() / 1000) + this.clockOffsetSec;
  }

  private startTakerWatch(card: Card, p: TakerProgress, reason: "no_fill" | "remainder"): void {
    const { cfg } = this.d;
    if (!this.live || cfg.reentryUntilSeconds <= 0) return;
    if (this.serverNowSec() - card.windowStartTs >= cfg.reentryUntilSeconds || p.sends >= TAKER_MAX_SENDS_PER_WINDOW) return;
    this.building.set(`${card.symbol}:${card.windowStartTs}`, p);
    const info = { reason, untilSec: cfg.reentryUntilSeconds, remainingUsd: this.remainingUsd(p), totalShares: p.shares, sends: p.sends };
    this.d.log("TAKER WATCH: buying the rest the first time the ask is back in range", { symbol: card.symbol, window: card.windowStartTs, ...info });
    this.d.reporter.report("event", card.symbol, card.windowStartTs, { event: "taker_watch", execution: "taker", ...info });
  }

  /** One look at a watched window (every tick). Sends at most once, and only when every check passes. */
  private async continueTaker(card: Card, nowSec: number, p: TakerProgress): Promise<void> {
    const { cfg, store, trader } = this.d;
    const key = `${card.symbol}:${card.windowStartTs}`;
    const end = (reason: string) => {
      this.building.delete(key);
      const info = { reason, sends: p.sends, totalShares: p.shares, remainingUsd: this.remainingUsd(p) };
      this.d.log("TAKER WATCH OVER", { symbol: card.symbol, window: card.windowStartTs, ...info });
      this.d.reporter.report("event", card.symbol, card.windowStartTs, { event: "taker_watch_end", execution: "taker", ...info });
    };
    if (!card.hasPrediction || !card.take || !card.lean) return end("signal_revoked");
    if (nowSec - card.windowStartTs >= cfg.reentryUntilSeconds) return end("deadline");
    if (p.sends >= TAKER_MAX_SENDS_PER_WINDOW) return end("max_sends");
    if (this.d.nowMs() - p.lastSendMs < TAKER_WATCH_GAP_MS) return;
    if ((await store.dayStats(card.windowStartTs)).realizedPnlUsd <= -cfg.rules.dailyLossLimitUsd) return end("daily_loss_limit");
    if (!trader || !this.builderCode) return;

    const check = await this.purchaseCheck(p);
    if (check.state === "unknown_purchase") return end("unexpected_purchase");
    if (check.state !== "ok") return; // can't confirm: look again next tick, send nothing now
    let balance: number;
    try {
      balance = await this.liveBalance();
    } catch {
      return;
    }
    if (balance < this.remainingUsd(p)) return;

    const r = await this.takerAttempt(card, p, p.sends + 1, TAKER_MAX_SENDS_PER_WINDOW, true);
    if (r.kind === "error") return end("error");
    if (r.kind === "filled" && this.remainderDone(p)) return end("complete");
    if (r.kind === "below_min_order_size" && p.shares > 0) return end("complete");
    // No match, ask out of range, no asks, book unreadable: keep watching.
  }

  /** Drops every taker watch (kill switch, revoked token). */
  private dropTakerWatches(why: string): void {
    if (this.building.size === 0) return;
    this.d.log("taker watches dropped", { why, windows: [...this.building.keys()] });
    this.building.clear();
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
