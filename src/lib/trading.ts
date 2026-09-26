/**
 * Maker-price and order-expiration rules, verified against hand-computed vectors in
 * scripts/test-trading.mjs.
 *
 * Faithful port of compute_maker_price and the order-expiration logic. Two deliberate
 * differences from the bot, both because a browser tab is not a persistent process:
 *   1. Prices use fixed-point arithmetic here (see round6/floorToStep) instead of Python's
 *      Decimal - behaviorally the same for the 2-6 decimal values this deals with, just
 *      without pulling in a bignum library for it.
 *   2. Order expiration (computeOrderExpiration) is new: the bot's GTD expiration is a
 *      backstop behind its own process-level TTL loop ("60 + ORDER_TTL_SECONDS"). This app
 *      has no server-side process holding the order open, so the GTD expiration IS the
 *      enforcement mechanism, capped to the market window's end per an explicit instruction
 *      that an order must never outlive its 15-minute window.
 */

// trader.py: PRICE_MIN / PRICE_MAX defaults (env-overridable there; fixed here since only
// ORDER_TTL_SECONDS was asked to be configurable in this app).
export const PRICE_MIN = 0.5;
export const PRICE_MAX = 0.6;

// trader.py comment: "polymarket-client 0.10.0 raises UserInputError for any GTD expiration
// less than 180s out ... checked against time.time() at call time -- so the margin over 180
// covers a second boundary ticking over between our timestamp and the SDK's check."
// This is the SDK's own client-side validation floor on the raw `expiration` value sent to
// placeLimitOrder - distinct from GTD_EARLY_CANCEL_BUFFER_SECONDS below, which is about what
// the exchange actually does with that value once accepted.
export const MIN_GTD_EXPIRATION_SECONDS = 190;

// Documented Polymarket behavior (docs.polymarket.com/trading/place-orders, checked
// 2026-09-21): "GTD orders expire one minute before their stated expiration as a security
// threshold." So a GTD order with `expiration: T` actually stops resting at T-60, not T.
// computeOrderExpiration compensates for this so the ORDER'S REAL, EFFECTIVE deadline lands
// where intended (min(now+TTL, windowEnd)), by adding this back onto the value we send.
export const GTD_EARLY_CANCEL_BUFFER_SECONDS = 60;

// Shares are always rounded to 2 decimal places (trader.py: `.quantize(Decimal("0.01"))`),
// which also matches Polymarket's own size-decimals for every tick size in use (see
// docs.polymarket.com/trading/place-orders).
const SHARE_DECIMALS = 2;

/** Rounds to 6 decimal places via integer arithmetic, avoiding float noise from a single
 * multiply (e.g. 0.53 - 0.01 in raw floating point). 6dp matches pUSD/CLOB's own on-chain
 * amount precision, well beyond any tick size Polymarket uses (0.01 or 0.001). */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// Fixed micro-unit scale (6dp) used to floor a value to an arbitrary step exactly. Must be
// finer than `step`'s own decimal places, or a value that falls exactly halfway between two
// steps (e.g. 0.4995 against a 0.001 step) gets rounded up to the next step BEFORE the floor
// division runs, silently turning a floor into a round. 1e6 has headroom over every tick
// size Polymarket uses (0.01, 0.001).
const MICRO = 1_000_000;

/** Floors `value` down to the nearest multiple of `step`. Mirrors Python's
 * `(value / tick).to_integral_value(ROUND_FLOOR) * tick`. */
function floorToStep(value: number, step: number): number {
  const valueMicro = Math.round(value * MICRO);
  const stepMicro = Math.round(step * MICRO);
  return (Math.floor(valueMicro / stepMicro) * stepMicro) / MICRO;
}

function floorToDecimals(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.floor(round6(value) * scale) / scale;
}

export type MakerPriceResult =
  | { ok: true; limitPrice: number; shares: number; bestAsk?: number }
  | { ok: false; reason: string; bestAsk?: number; minOrderSize?: number; attemptedPrice?: number };

export type OrderBookLevel = { price: string | number };

/** The lowest (best) ask price in a book's ask levels, or undefined if there are none.
 * Levels are not assumed sorted. */
export function bestAskOf(asks: OrderBookLevel[]): number | undefined {
  const askPrices = asks.map((a) => Number(a.price)).filter(Number.isFinite);
  return askPrices.length ? Math.min(...askPrices) : undefined;
}

/**
 * Port of compute_maker_price (trader.py:348-367). The highest price that is guaranteed to
 * rest as a maker and never exceeds entryPrice.
 */
export function computeMakerPrice(params: {
  entryPrice: number;
  tickSize: number;
  minOrderSize: number;
  asks: OrderBookLevel[];
  stakeUsd: number;
}): MakerPriceResult {
  const { entryPrice, tickSize, minOrderSize, asks, stakeUsd } = params;
  let limit = floorToStep(entryPrice, tickSize);

  const bestAsk = bestAskOf(asks);
  if (bestAsk !== undefined) {
    // one tick below best ask -> guaranteed to rest, never cross
    limit = Math.min(limit, floorToStep(bestAsk - tickSize, tickSize));
  }
  if (limit < tickSize) {
    return { ok: false, reason: `no_room_to_rest (best_ask=${bestAsk}, tick=${tickSize})`, bestAsk };
  }

  const shares = floorToDecimals(stakeUsd / limit, SHARE_DECIMALS);
  if (shares < minOrderSize) {
    return { ok: false, reason: `below_min_order_size (${shares} < ${minOrderSize})`, bestAsk, minOrderSize, attemptedPrice: limit };
  }
  return { ok: true, limitPrice: limit, shares, bestAsk };
}

/** Floors a raw share count to this app's own 2dp share convention. Used by the "Fill now"
 * conversion (see SignalCard's fillNow) to compute the remaining unfilled size after
 * subtracting a maker leg's own filled amount, which can itself carry float noise (real
 * partial fills have summed to values like 49.99365 - see order-status.ts). Clamped at 0 so
 * a fill recorded fractionally over the nominal size (rounding noise, never observed the
 * other way but not provably impossible) can't produce a negative "remaining". */
export function roundRemainingShares(shares: number): number {
  return Math.max(0, floorToDecimals(shares, SHARE_DECIMALS));
}

/**
 * Port of trader.py's manual-tap taker-price computation, adapted for this app's "Fill now"
 * conversion (see SignalCard's fillNow / MAKER_FILL_TIMEOUT_SECONDS): floors the live best
 * ask down to the tick - quoting AT the touch, not one tick below it like
 * computeMakerPrice - so the order is marketable and crosses the spread instead of resting.
 * Takes `remainingShares` directly (not a dollar stake): by the time this runs, the caller
 * already knows exactly how many shares are left unfilled on the maker leg being converted,
 * and re-deriving that from a stake would just reintroduce rounding this doesn't need.
 * Deliberately does NOT apply trader.py's own separate MAX_TAKER_PRICE convention - the
 * band check for this app's "Fill now" is the same 50-60c PRICE_MIN/PRICE_MAX rule used
 * everywhere else here (isPriceInBand), checked by the caller against this result's
 * limitPrice, per an explicit instruction to use that exact rule for this flow.
 */
export function computeTakerPrice(params: {
  tickSize: number;
  minOrderSize: number;
  asks: OrderBookLevel[];
  remainingShares: number;
}): MakerPriceResult {
  const { tickSize, minOrderSize, asks, remainingShares } = params;
  const bestAsk = bestAskOf(asks);
  if (bestAsk === undefined) {
    return { ok: false, reason: "no_liquidity (no asks on the book)" };
  }
  const limit = floorToStep(bestAsk, tickSize);
  if (limit < tickSize) {
    return { ok: false, reason: `no_room_to_cross (best_ask=${bestAsk}, tick=${tickSize})`, bestAsk };
  }
  const shares = roundRemainingShares(remainingShares);
  if (shares < minOrderSize) {
    return { ok: false, reason: `below_min_order_size (${shares} < ${minOrderSize})`, bestAsk, minOrderSize, attemptedPrice: limit };
  }
  return { ok: true, limitPrice: limit, shares, bestAsk };
}

/**
 * Test-mode pricing: the price is FIXED and must never be influenced by the live book.
 * Deliberately does not look at asks at all - computeMakerPrice's "clamp to one tick below
 * best ask" is correct for real orders (never cross the spread) but is exactly what made a
 * test order fill for real: late in a window, the losing side's best ask can fall below a
 * "safely low" forced test price, and the clamp then LOWERS the order to match the live
 * (fillable) market instead of leaving it at the fixed, unfillable price. This function
 * can't reproduce that bug because it has no access to ask prices in the first place.
 */
export function computeTestPrice(params: { price: number; minOrderSize: number; stakeUsd: number }): MakerPriceResult {
  const { price, minOrderSize, stakeUsd } = params;
  const shares = floorToDecimals(stakeUsd / price, SHARE_DECIMALS);
  if (shares < minOrderSize) {
    return { ok: false, reason: `below_min_order_size (${shares} < ${minOrderSize})`, minOrderSize, attemptedPrice: price };
  }
  return { ok: true, limitPrice: price, shares };
}

// Smallest stake (USD) that could reach a market's minimum order size at a given price - an
// ESTIMATE, shown before placing (the real required stake can be a touch higher once price
// is floored to a tick - see computeMakerPrice), used both to phrase a plain-language
// minimum and to gate the TAKE button before the picker even opens, given only what's
// already on the card (its entry price) plus the market's own minOrderSize.
export function minStakeForOrder(price: number, minOrderSize: number): number {
  return price * minOrderSize;
}

/** Turns a MakerPriceResult failure into plain language for display, instead of surfacing
 * its internal `reason` code (e.g. "below_min_order_size (2.22 < 5)") raw - that string is
 * meant for logs/tests (see test-trading.mjs), not a trading screen. */
export function friendlyPricingError(priced: { ok: false; reason: string; minOrderSize?: number; attemptedPrice?: number }): string {
  if (priced.reason.startsWith("below_min_order_size") && priced.minOrderSize !== undefined && priced.attemptedPrice !== undefined) {
    const minUsd = minStakeForOrder(priced.attemptedPrice, priced.minOrderSize);
    return `Minimum order is ${priced.minOrderSize} shares (about $${minUsd.toFixed(2)} at this price). Add funds to take this signal.`;
  }
  if (priced.reason.startsWith("no_room_to_rest") || priced.reason.startsWith("no_room_to_cross")) {
    return "The market moved too close to place a safe order right now. Try again in a moment.";
  }
  if (priced.reason.startsWith("no_liquidity")) {
    return "No liquidity on the book right now. Try again in a moment.";
  }
  return "Can't place a safe order right now. Try again in a moment.";
}

// A fixed test price is only meaningfully "safe" (unlikely to be filled by ordinary market
// movement) when the live market isn't already trading close to it - post-only only blocks
// crossing AT PLACEMENT, not a later fill once the order is resting and the market moves
// down to meet it (exactly what happened: the market crashed through 0.003 near a window's
// end). This is a blunt, deliberately conservative floor, not a precise risk model.
export const TEST_MIN_SAFE_ASK = 0.05;

/** Should a test order be refused because the live market is already too close to the
 * forced test price? true = refuse. No ask on the book at all is not flagged here - there
 * is nothing resting to fall through, so it isn't the risk this guard is for. */
export function isTestAskTooClose(bestAsk: number | undefined): boolean {
  return bestAsk !== undefined && bestAsk < TEST_MIN_SAFE_ASK;
}

// Two real test orders lost money testing on whichever side the model happened to lean,
// including once on a side that was actively collapsing toward zero as its window
// resolved. Test mode now picks its own side instead of inheriting a real signal's
// direction: only a side priced at or above this is eligible - comfortably not one that's
// already resolving away. Deliberately higher than TEST_MIN_SAFE_ASK (0.05); the two exist
// for different reasons (this one: don't test a side that's about to lose: that one: don't
// test a price too close to what's already trading) and may not always move together.
export const TEST_MIN_ASK_TO_ENTER = 0.4;

/** Which side (if either) test mode may trade, given each side's live best ask. Prefers
 * "up" when both qualify - an arbitrary but deterministic tie-break, not a signal. */
export function pickTestSide(upAsk: number | undefined, downAsk: number | undefined): "up" | "down" | undefined {
  if (upAsk !== undefined && upAsk >= TEST_MIN_ASK_TO_ENTER) return "up";
  if (downAsk !== undefined && downAsk >= TEST_MIN_ASK_TO_ENTER) return "down";
  return undefined;
}

/** Port of trader.py's `limit_in_band` / the `PRICE_MIN <= entry <= PRICE_MAX` filter,
 * as a pre-trade re-check against a freshly computed price. Compares at 4dp fixed point
 * so exact-boundary values (0.50, 0.60) are never mis-classified by float rounding. */
export function isPriceInBand(price: number): boolean {
  const c = Math.round(price * 10_000);
  return c >= Math.round(PRICE_MIN * 10_000) && c <= Math.round(PRICE_MAX * 10_000);
}

/**
 * The range of live prices a TAKE may be placed at, in cents. The upper limit (default 60)
 * blocks chasing a market that has run away; the lower limit (default 0 = none) is how far
 * down a "Take anyway" entry is allowed to go. The USUAL range is still PRICE_MIN-PRICE_MAX
 * (50-60c): that is where the signal was found, and below it the app asks for a deliberate
 * "Take anyway" instead of a normal TAKE. Configured via ENTRY_MIN_CENTS / ENTRY_MAX_CENTS.
 */
export type EntryRange = { minCents: number; maxCents: number };
export const DEFAULT_ENTRY_RANGE: EntryRange = { minCents: 0, maxCents: PRICE_MAX * 100 };
/** The original fixed 50-60c range (what the shadow worker's primary rule still uses). */
export const USUAL_ENTRY_RANGE: EntryRange = { minCents: PRICE_MIN * 100, maxCents: PRICE_MAX * 100 };

/** Parses ENTRY_MIN_CENTS / ENTRY_MAX_CENTS (unset/empty = the defaults). Throws on nonsense
 * rather than silently trading on a range the operator didn't intend. */
export function parseEntryRange(minRaw?: string, maxRaw?: string): EntryRange {
  const num = (name: string, raw: string | undefined, fallback: number) => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${name} must be a number of cents between 0 and 100, got ${JSON.stringify(raw)}.`);
    return n;
  };
  const minCents = num("ENTRY_MIN_CENTS", minRaw, DEFAULT_ENTRY_RANGE.minCents);
  const maxCents = num("ENTRY_MAX_CENTS", maxRaw, DEFAULT_ENTRY_RANGE.maxCents);
  if (minCents > maxCents) throw new Error(`ENTRY_MIN_CENTS (${minCents}) must not be above ENTRY_MAX_CENTS (${maxCents}).`);
  return { minCents, maxCents };
}

/** Is `price` (0-1) inside the range? 4dp fixed point, so exact boundaries (0.5, 0.6) are never
 * mis-classified by float rounding. */
export function isPriceAllowed(price: number, range: EntryRange): boolean {
  const c = Math.round(price * 10_000);
  return c >= Math.round(range.minCents * 100) && c <= Math.round(range.maxCents * 100);
}

export type PriceZone =
  | "usual" // inside 50-60c (and the range): a normal TAKE
  | "below_usual" // under 50c but allowed by the range: "Take anyway"
  | "below_limit" // under the configured lower limit: no trade
  | "above_limit"; // over the upper limit: no trade

export function classifyPrice(price: number, range: EntryRange): PriceZone {
  const c = Math.round(price * 10_000);
  if (c > Math.round(range.maxCents * 100)) return "above_limit";
  if (c < Math.round(range.minCents * 100)) return "below_limit";
  if (c < Math.round(PRICE_MIN * 10_000)) return "below_usual";
  return "usual";
}

/** Plain-language range for messages: "up to 60c" (no lower limit) or "between 40c and 60c". */
export function describeRange(range: EntryRange): string {
  return range.minCents > 0 ? `between ${range.minCents}¢ and ${range.maxCents}¢` : `up to ${range.maxCents}¢`;
}

export type ExpirationResult = { ok: true; expiration: number } | { ok: false; reason: "window_too_close_to_end" };

/**
 * Where this app's TTL and trader.py's diverge (see file header): the order's real,
 * EFFECTIVE deadline is min(now + ttlSeconds, windowEndTs) - it can never outlive the
 * window. Returns the STATED `expiration` value to actually send to placeLimitOrder,
 * which is 60s later than that (see GTD_EARLY_CANCEL_BUFFER_SECONDS) so the exchange's own
 * early-cancel behavior lands the real cancellation at the intended deadline, not 60s
 * before it - except right at the window's end, where the stated value is capped at
 * windowEndTs itself (never later), so the real cancellation there lands up to 60s EARLY
 * rather than risk sending a GTD expiration that implies resting past the window - the
 * safe direction, given "never outlive the window" is a hard requirement here.
 *
 * If even the SDK's own minimum GTD buffer would run past the window's end, there is no
 * safe expiration to give the order at all, so callers should refuse to place it (mirrors
 * this app's other "too little time left" pre-trade guards).
 */
export function computeOrderExpiration(nowSeconds: number, ttlSeconds: number, windowEndTs: number): ExpirationResult {
  const minAllowed = nowSeconds + MIN_GTD_EXPIRATION_SECONDS;
  if (minAllowed > windowEndTs) return { ok: false, reason: "window_too_close_to_end" };

  const effectiveDeadline = Math.min(nowSeconds + ttlSeconds, windowEndTs);
  const stated = Math.min(effectiveDeadline + GTD_EARLY_CANCEL_BUFFER_SECONDS, windowEndTs);
  return { ok: true, expiration: Math.max(stated, minAllowed) };
}
