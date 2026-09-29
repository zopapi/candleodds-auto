// Taker execution (AUTOTRADE_EXECUTION=taker): pure helpers, no I/O. In taker mode nothing ever
// rests. At the decision point the engine sends an immediate fill-and-kill order at the best ask,
// re-reading the order book right before each send. The price cap is
//     min(best ask + TAKER_SLIPPAGE_CENTS, ENTRY_MAX_CENTS)
// so a one-cent move between reading the book and the order landing does not kill the trade, while
// ENTRY_MAX_CENTS (60c by default) stays a hard ceiling: an ask above it is skipped, never chased.
// The pricing and fee maths are shared with the in-app TAKE button (src/lib/taker.ts).
import { type EntryRange } from "../../src/lib/trading.ts";
import { planTakerAttempt } from "../../src/lib/taker.ts";
import type { BookInfo, CardLike, Decision, ShadowConfig } from "../decision.ts";

export {
  feeFor,
  planTakerAttempt,
  sizeAtOrBelow,
  takerFeeUsd,
  TAKER_FEE_RATE,
  topOfBook,
  unknownPurchaseShares,
  type BookSnapshot,
  type TakerPlan,
} from "../../src/lib/taker.ts";

export type ExecutionMode = "maker_first" | "taker";

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
