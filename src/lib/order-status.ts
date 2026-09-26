/**
 * Derives an order's status WITHOUT ever calling fetchOrder/listOpenOrders. Confirmed
 * (see the trading-incident writeup, and a dedicated live probe against production) that
 * Polymarket's order-lookup endpoints return an empty list / a null order for this
 * account's wallet type (POLY_1271 deposit wallet) even for orders that are demonstrably
 * still live - one filled in five partial trades roughly 18 seconds after a listOpenOrders
 * call found nothing; another kept fetchOrder returning null ~1-2 minutes after placement.
 * Two independent hypotheses for why (POLY_ADDRESS=signer, a rotating API key) were each
 * checked and ruled out - see pm-provider.tsx/DebugOpenOrders.tsx - so the cause is still
 * unconfirmed, but the app no longer needs it: everything here comes from what we already
 * know locally (when an order was placed, when it expires) plus the SAME public
 * trades/activity feed already used elsewhere in this app (data-api.polymarket.com,
 * unauthenticated, confirmed reliable throughout this investigation - every fill this app
 * has ever seen showed up there correctly and promptly).
 */

export type OrderStatusKind = "resting" | "filled" | "cancelled" | "expired";

// Module-scope, not called inline as `Math.floor(Date.now() / 1000)` inside a component -
// the React Compiler's purity check flags Date.now() called directly in component-scoped
// code as a potential during-render impurity. A plain module-level function (this one,
// shared by every caller that needs "now" for status resolution) sidesteps that entirely.
export function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export type ActivityEntry = {
  type: string; // "TRADE" | "REDEEM" | ...
  asset: string; // token id
  side: string; // "BUY" | "SELL" | ""
  size: number;
  price: number;
  timestamp: number; // unix seconds
  // Display-only fields the public activity feed also carries (confirmed present on real
  // TRADE entries) - optional here since the fill-matching logic above never reads them;
  // only the Positions "Recent fills" list (positions/page.tsx) does.
  title?: string; // e.g. "Ethereum Up or Down - September 22, 8:30AM-8:45AM ET"
  slug?: string;
  outcome?: string; // "Up" | "Down"
  conditionId?: string;
  eventSlug?: string;
  transactionHash?: string; // the on-chain transaction of this fill (Polygonscan link)
};

// Prices are decimal strings on both the order and the trade record, formatted by the same
// system on both sides - exact equality should hold, but a tiny epsilon guards against any
// float round-trip noise without being loose enough to blur genuinely different prices
// (the smallest tick size in use is 0.001).
const PRICE_EPSILON = 1e-6;

/**
 * Total shares filled for a specific order: BUY trades on its exact token, at its exact
 * limit price (a maker's post-only order always fills AT that price - never better AND
 * never worse - so this is a strong match key, not just a heuristic), timestamped at or
 * after it was placed. The price match matters: without it, two different orders on the
 * SAME token placed close together in time (e.g. two Test TAKE attempts) could have their
 * fills double-counted or attributed to the wrong order - this narrows that near-shut.
 */
export function sumFilledSince(
  activity: ActivityEntry[],
  tokenId: string,
  limitPrice: number,
  placedAtSec: number,
  bufferSec = 5, // tolerates clock skew between our placedAt and the indexer's timestamp
): number {
  const cutoff = placedAtSec - bufferSec;
  return activity
    .filter(
      (a) =>
        a.type === "TRADE" &&
        a.asset === tokenId &&
        a.side === "BUY" &&
        Math.abs(a.price - limitPrice) < PRICE_EPSILON &&
        a.timestamp >= cutoff,
    )
    .reduce((sum, a) => sum + a.size, 0);
}

// Real activity for the ETH order that filled in 5 partial trades summed to 49.99365, not
// exactly its nominal 50 shares (see scripts/test-order-status.mjs's real vector) - no
// further fill ever arrived, confirming this WAS the complete fill, just short of the
// nominal size for whatever reason (rounding somewhere in Polymarket's own matching or fee
// accounting - not something this app controls). An exact `filled >= shares` check would
// have left a genuinely fully-filled order stuck showing "resting" forever. One hundredth
// of a share - tied to this app's own SHARE_DECIMALS (2dp) convention in trading.ts, not
// an arbitrary number - safely covers that gap without being loose enough to call a
// meaningfully-partial fill "complete".
const FULL_FILL_TOLERANCE_SHARES = 0.01;

export type OrderLike = {
  shares: number;
  limitPrice: number;
  placedAt: number; // ms epoch
  expiresAt: number; // sec epoch (GTD expiration)
  status: OrderStatusKind; // current stored status - see the "cancelled is sticky" note below
  tokenId: string;
};

/**
 * "cancelled" is sticky: once a cancel call is CONFIRMED by its own response (not a lookup
 * - see SignalCard's cancel handlers, which set this directly), this function always
 * returns it unchanged, even if activity later shows a fill. A cancel racing a fill is a
 * real, narrow edge case this can't resolve perfectly (the order stopped being cancellable
 * in that same instant, and the exchange's cancel response no longer perfectly reflects
 * final reality) - staying with the more specific, directly-confirmed signal rather than
 * silently overwriting it is the more honest failure mode.
 */
export function resolveOrderStatus(
  order: OrderLike,
  activity: ActivityEntry[],
  nowSec: number,
): { status: OrderStatusKind; filledShares: number } {
  const filledShares = Math.min(
    sumFilledSince(activity, order.tokenId, order.limitPrice, Math.floor(order.placedAt / 1000)),
    order.shares,
  );
  if (order.status === "cancelled") return { status: "cancelled", filledShares };
  if (order.shares - filledShares <= FULL_FILL_TOLERANCE_SHARES) return { status: "filled", filledShares };
  if (nowSec >= order.expiresAt) return { status: "expired", filledShares };
  return { status: "resting", filledShares };
}
