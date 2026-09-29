// Taker (fill-and-kill) pricing shared by the in-app TAKE button and the self-hosted worker. Pure: no I/O.
// A taker buy sends an immediate fill-and-kill order at the real best ask, capped at
//     min(best ask + slippage, top of the entry range)
// so a one-cent move between reading the book and the order landing does not kill the trade, while the top of the
// range (60c) stays a hard ceiling: an ask above it is refused, never chased. Nothing ever rests.
import { isPriceAllowed, type EntryRange, type OrderBookLevel } from "./trading.ts";

/** Polymarket's published taker fee for the 15-minute crypto markets: fee = shares x rate x p x (1 - p),
 * paid in USDC by the TAKER only (makers are never charged). It does NOT include any builder fee. */
export const TAKER_FEE_RATE = 0.07;

/** The in-app TAKE never pays more than this, whatever ENTRY_MAX_CENTS says. */
export const APP_TAKER_MAX_CENTS = 60;
/** The in-app TAKE allows the same 1c move between reading the book and the order landing as the worker. */
export const APP_TAKER_SLIPPAGE_CENTS = 1;

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

/** One ask level. Sizes are in shares; optional because some books (and old fakes) give none. */
export type AskLevel = OrderBookLevel & { size?: string | number };

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

const sizeOf = (l: AskLevel): number | undefined => {
  const n = Number(l.size);
  return l.size === undefined || !Number.isFinite(n) ? undefined : n;
};

/** Shares offered at or below `price` (undefined if any level in that range gave no size). */
export function sizeAtOrBelow(asks: AskLevel[], price: number): number | undefined {
  const within = asks.filter((l) => Number(l.price) <= price + 1e-9);
  return within.every((l) => sizeOf(l) !== undefined) ? round6(within.reduce((s, l) => s + (sizeOf(l) as number), 0)) : undefined;
}

/** The cheapest `n` ask levels as [price, size] pairs, for logs and reports. */
export function topOfBook(asks: AskLevel[], n = 5): [number, number | null][] {
  return asks
    .map((l) => [Number(l.price), sizeOf(l) ?? null] as [number, number | null])
    .filter(([p]) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a[0] - b[0])
    .slice(0, n);
}

/**
 * One taker attempt from a FRESH book: the best (lowest) real ask, the cap, and the shares one stake buys.
 *   cap = min(best ask + slippage, top of the entry range), on the tick grid but never below the ask.
 * Returns ok:false when there is no ask, the ask itself is outside the entry range (never chased), or the
 * stake could not reach the market's minimum order size at the cap.
 */
export function planTakerAttempt(params: {
  asks: AskLevel[];
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
  const sizeWithinCap = sizeAtOrBelow(asks, cap);

  const shares = Math.floor((stakeUsd / cap) * 100 + 1e-9) / 100; // conservative: at the cap, the worst price
  if (shares < minOrderSize) return { ok: false, reason: "below_min_order_size", bestAsk, askSize, cap };
  return { ok: true, book: { bestAsk, askSize, sizeWithinCap, cap }, shares };
}

/** The range the in-app TAKE buys in: the configured range, with the top clamped to APP_TAKER_MAX_CENTS. */
export function appTakerRange(range: EntryRange): EntryRange {
  return { minCents: Math.min(range.minCents, APP_TAKER_MAX_CENTS), maxCents: Math.min(range.maxCents, APP_TAKER_MAX_CENTS) };
}

/** The in-app TAKE (buy now): the worker's plan with the app's 1c allowance and the 60c ceiling. */
export function planAppTake(params: { asks: AskLevel[]; tickSize: number; minOrderSize: number; stakeUsd: number; range: EntryRange }): TakerPlan {
  return planTakerAttempt({ ...params, slippageCents: APP_TAKER_SLIPPAGE_CENTS, range: appTakerRange(params.range) });
}

/**
 * What a buy-now stake gets at `price`, for the button: the fee comes out of the stake (the order's all-in spend never
 * exceeds it), so shares = stake / (price x (1 + fee rate x (1 - price))). Pays `payoutUsd` if it wins.
 */
export function takerPreview(stakeUsd: number, price: number): { shares: number; feeUsd: number; payoutUsd: number } {
  if (!(stakeUsd > 0) || !(price > 0) || !(price < 1)) return { shares: 0, feeUsd: 0, payoutUsd: 0 };
  const shares = Math.floor((stakeUsd / (price * (1 + TAKER_FEE_RATE * (1 - price)))) * 100 + 1e-9) / 100;
  return { shares, feeUsd: takerFeeUsd(shares, price), payoutUsd: shares };
}

/** What the TAKE button should say about a plan that can't be sent. */
export function friendlyTakerRefusal(plan: Extract<TakerPlan, { ok: false }>, range: EntryRange): string {
  const cents = (p: number) => `${Math.round(p * 1000) / 10}c`;
  if (plan.reason === "no_liquidity") return "Nobody is selling this side right now. Not buying.";
  if (plan.reason === "below_min_order_size") return "That stake is below this market's minimum order size. Try a larger stake.";
  const r = appTakerRange(range);
  if (plan.bestAsk !== undefined && plan.bestAsk * 100 > r.maxCents + 1e-9) return `Price moved above ${r.maxCents}c (ask ${cents(plan.bestAsk)}). Not buying.`;
  return `Price is outside the ${r.minCents}-${r.maxCents}c range (ask ${plan.bestAsk !== undefined ? cents(plan.bestAsk) : "none"}). Not buying.`;
}

/** Polymarket's market slug for a 15-minute window, e.g. eth-updown-15m-1790685900. */
export function windowSlug(symbol: string, windowStartTs: number): string {
  return `${symbol}-updown-15m-${windowStartTs}`;
}

/** Has this wallet already bought or sold in this window's market (either side), by hand or by the Auto bot? */
export function alreadyTradedWindow(activity: { type: string; slug?: string }[], symbol: string, windowStartTs: number): boolean {
  const slug = windowSlug(symbol, windowStartTs);
  return activity.some((a) => a.type === "TRADE" && a.slug === slug);
}

/**
 * Shares of `tokenId` the public feed shows this wallet BUYING since `sinceSec` beyond `knownShares` (what this
 * process bought itself). More than a rounding tolerance means someone else bought (e.g. by hand in the app) and a
 * follow-up order must not be sent. Feed lag only ever shows LESS than we bought, which is fine.
 */
export function unknownPurchaseShares(
  activity: { type: string; asset: string; side: string; size?: number; timestamp: number }[],
  tokenId: string,
  sinceSec: number,
  knownShares: number,
): number {
  const seen = activity
    .filter((a) => a.type === "TRADE" && a.asset === tokenId && a.side === "BUY" && a.timestamp >= sinceSec - 5)
    // A purchase with no readable size can't be accounted for, so it counts as unknown.
    .reduce((s, a) => s + (Number.isFinite(Number(a.size)) && a.size !== undefined ? Number(a.size) : Infinity), 0);
  const extra = seen - knownShares;
  return extra > Math.max(0.05, knownShares * 0.01) ? round6(extra) : 0;
}
