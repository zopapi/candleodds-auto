// Taker execution (AUTOTRADE_EXECUTION=taker): pure helpers, no I/O. In taker mode nothing ever
// rests. At the decision point the engine sends an immediate fill-and-kill order at the best ask,
// re-reading the order book right before each send. The price cap is
//     min(best ask + TAKER_SLIPPAGE_CENTS, ENTRY_MAX_CENTS)
// so a one-cent move between reading the book and the order landing does not kill the trade, while
// ENTRY_MAX_CENTS (60c by default) stays a hard ceiling: an ask above it is skipped, never chased.
import { isPriceAllowed, type EntryRange } from "../../src/lib/trading.ts";
import type { BookInfo, CardLike, Decision, ShadowConfig } from "../decision.ts";
import type { BookLevel } from "./types.ts";

export type ExecutionMode = "maker_first" | "taker";

/** Polymarket's published taker fee for the 15-minute crypto markets: fee = shares x rate x p x (1 - p),
 * paid in USDC by the TAKER only (makers are never charged). It does NOT include any builder fee. */
export const TAKER_FEE_RATE = 0.07;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** Round down to a whole number of ticks (fixed point, so 0.58 stays 0.58, never 0.5799999). */
const floorToStep = (value: number, step: number) => round6(Math.floor(value / step + 1e-9) * step);

/** Estimated Polymarket taker fee (USD) for buying `shares` at `price`. Polymarket rounds fees to 5 decimals, and the
 * first two real fills (checked on-chain, Sep 25) were both consistent with rounding DOWN: 0.159236 was charged as
 * 0.15923 and 0.153090 as 0.15309. The docs don't say whether it truncates, so this follows the observed behaviour. */
export function takerFeeUsd(shares: number, price: number, rate = TAKER_FEE_RATE): number {
  if (!(shares > 0) || !(price > 0) || !(price < 1)) return 0;
  const fee = shares * rate * price * (1 - price);
  return Math.floor(fee * 1e5 + 1e-7) / 1e5; // the epsilon only absorbs float noise (a fee of exactly 1.75 stays 1.75)
}

/** Fee for a fill: a maker fill is free; a taker fill uses the published formula. */
export function feeFor(kind: "maker" | "taker", shares: number, price: number): number {
  return kind === "maker" ? 0 : takerFeeUsd(shares, price);
}

/** The real order book, reduced to what a taker order needs. Sizes are in shares. */
export type BookSnapshot = {
  bestAsk: number;
  /** Shares offered at exactly the best ask (undefined if the book gave no size). */
  askSize?: number;
  /** Shares offered at or below `cap`, i.e. what the order could actually take. */
  sizeWithinCap?: number;
  cap: number;
};

export type TakerPlan =
  | { ok: true; book: BookSnapshot; shares: number }
  | { ok: false; reason: "no_liquidity" | "ask_out_of_range" | "below_min_order_size"; bestAsk?: number; askSize?: number; cap?: number };

const sizeOf = (l: BookLevel): number | undefined => {
  const n = Number(l.size);
  return l.size === undefined || !Number.isFinite(n) ? undefined : n;
};

/**
 * One taker attempt from a FRESH book: the best (lowest) real ask, the cap, and the shares one stake buys.
 *   cap = min(best ask + slippage, top of the entry range), on the tick grid but never below the ask.
 * Returns ok:false when there is no ask, the ask itself is outside the entry range (never chased), or the
 * stake could not reach the market's minimum order size at the cap.
 */
export function planTakerAttempt(params: {
  asks: BookLevel[];
  tickSize: number;
  minOrderSize: number;
  stakeUsd: number;
  slippageCents: number;
  range: EntryRange;
}): TakerPlan {
  const { asks, tickSize, minOrderSize, stakeUsd, slippageCents, range } = params;
  const levels = asks.map((l) => ({ price: Number(l.price), size: sizeOf(l) })).filter((l) => Number.isFinite(l.price) && l.price > 0);
  if (!levels.length) return { ok: false, reason: "no_liquidity" };

  const bestAsk = Math.min(...levels.map((l) => l.price));
  const atBest = levels.filter((l) => Math.abs(l.price - bestAsk) < 1e-9);
  const askSize = atBest.every((l) => l.size !== undefined) ? round6(atBest.reduce((s, l) => s + (l.size as number), 0)) : undefined;

  // The ask itself must be inside the range: the cap only ever allows for slippage, it never widens the range.
  if (!isPriceAllowed(bestAsk, range)) return { ok: false, reason: "ask_out_of_range", bestAsk, askSize };

  const ceiling = range.maxCents / 100;
  const raw = Math.min(round6(bestAsk + slippageCents / 100), ceiling);
  const cap = Math.max(floorToStep(raw, tickSize), bestAsk); // on the grid, never below the ask we saw
  const within = levels.filter((l) => l.price <= cap + 1e-9);
  const sizeWithinCap = within.every((l) => l.size !== undefined) ? round6(within.reduce((s, l) => s + (l.size as number), 0)) : undefined;

  const shares = Math.floor((stakeUsd / cap) * 100 + 1e-9) / 100; // conservative: at the cap, the worst price
  if (shares < minOrderSize) return { ok: false, reason: "below_min_order_size", bestAsk, askSize, cap };
  return { ok: true, book: { bestAsk, askSize, sizeWithinCap, cap }, shares };
}

/**
 * The go/no-go decision from the live book (used at the decision point, and in shadow mode). Same
 * Decision shape the maker sizing returns, so the rest of the engine is unchanged; `limitPrice` is the
 * cap of the fill-and-kill order.
 */
export function sizeTakerDecision(card: CardLike, book: BookInfo, cfg: ShadowConfig, range: EntryRange, slippageCents = 1): Decision {
  if (card.entry === null) return { kind: "record", decision: "skipped", reason: "sizing_failed" };
  const plan = planTakerAttempt({ asks: book.asks, tickSize: book.tickSize, minOrderSize: book.minOrderSize, stakeUsd: cfg.stakeUsd, slippageCents, range });
  if (!plan.ok) {
    const reason = plan.reason === "ask_out_of_range" ? "price_out_of_band_at_sizing" : plan.reason === "below_min_order_size" ? "below_min_order_size" : "sizing_failed";
    return { kind: "record", decision: "skipped", reason };
  }
  return { kind: "record", decision: "would_place", limitPrice: plan.book.cap, shares: plan.shares, bestAsk: plan.book.bestAsk };
}

/**
 * Has this wallet already bought this token since the decision? Used before every retry: a fill-and-kill
 * that filled nothing cannot double-fill, but if ANYTHING is unclear (an order that may have landed, a fill
 * already in the public feed) the engine stops retrying rather than risk a second purchase.
 */
export function boughtSince(activity: { type: string; asset: string; side: string; timestamp: number }[], tokenId: string, sinceSec: number): boolean {
  return activity.some((a) => a.type === "TRADE" && a.asset === tokenId && a.side === "BUY" && a.timestamp >= sinceSec - 5);
}
