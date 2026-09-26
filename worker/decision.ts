// Pure decision logic for the shadow auto-trade worker: no network, no database, no clock
// (callers pass `nowSec`). Everything here is unit-tested in scripts/test-shadow.mjs.
//
// SHADOW MODE: nothing here places, signs or cancels anything. A "would_place" decision is a
// record of what a real engine WOULD have done, sized with the same maker-pricing math the
// app uses (src/lib/trading.ts), so the shadow log is comparable with real trading later.
import {
  computeMakerPrice,
  isPriceAllowed,
  parseEntryRange,
  USUAL_ENTRY_RANGE,
  type EntryRange,
  type OrderBookLevel,
} from "../src/lib/trading.ts";

export type ShadowConfig = {
  symbols: string[]; // e.g. ["btc", "eth"]
  stakeUsd: number;
  maxTradesPerDay: number;
  dailyLossLimitUsd: number; // positive number; decisions stop once realized shadow P&L <= -this
  // The ETH-confirmation BTC-short rule can take up to 8s to record its skip in
  // signal_rule_events, and get_live_signal_cards only excludes a skipped window once that
  // row exists - so a TAKE seen earlier than this after window open may still be revoked.
  waitSeconds: number; // 10
  // The alert cutoff: a signal acted on
  // later than this is trading on stale timing, not the entry-at-open edge.
  maxAgeSeconds: number; // 180
  // The COMPARISON rule recorded alongside the primary one for every TAKE: same guards, same
  // sizing, but a different live-price range (default: no lower limit, max 60c - the app's
  // "Take anyway" behaviour). The PRIMARY rule is always the usual 50-60c range.
  altRange: EntryRange;
};

export const DEFAULT_WAIT_SECONDS = 10;
export const DEFAULT_MAX_AGE_SECONDS = 180;

// The subset of get_live_signal_cards()'s row this logic reads (camelCase, as mapped by the
// worker's DB layer - same shape as src/lib/signals-db.ts's SignalCard).
export type CardLike = {
  symbol: string;
  windowStartTs: number;
  hasPrediction: boolean;
  lean: string | null;
  entry: number | null;
  take: boolean;
  currentPrice: number | null;
};

export type DayStats = { tradesToday: number; realizedPnlUsd: number };

export type BookInfo = { tickSize: number; minOrderSize: number; asks: OrderBookLevel[] };

export type Decision =
  | { kind: "ignore" } // not a TAKE for a symbol we trade - nothing to record
  | { kind: "defer" } // a TAKE, but too early to decide (inside the wait) - look again next tick
  | { kind: "need_book" } // passed every check that doesn't need the live book - fetch it, then call sizeDecision
  | { kind: "record"; decision: "skipped"; reason: string }
  | { kind: "record"; decision: "would_place"; limitPrice: number; shares: number; bestAsk?: number };

export const SKIP_REASONS = [
  "too_late",
  "no_live_price",
  "price_out_of_band",
  "max_trades_per_day",
  "daily_loss_limit",
  "no_room_to_rest",
  "below_min_order_size",
  "price_out_of_band_at_sizing",
  "sizing_failed",
] as const;

/** UTC calendar day a window belongs to, as [startSec, endSec) - the unit "per day" limits
 * are counted over. Anchored on the window's own start, not the wall clock, so a decision
 * for a window is always counted in the same day no matter when it's recorded. */
export function utcDayBounds(windowStartTs: number): { startSec: number; endSec: number } {
  const startSec = Math.floor(windowStartTs / 86_400) * 86_400;
  return { startSec, endSec: startSec + 86_400 };
}

/** Everything that can be decided from the card, the clock and today's running totals alone.
 * Order matters and is part of the contract (tests pin it): the first failing guard wins, so
 * a recorded reason is always the earliest thing that ruled the window out. */
export function precheck(
  card: CardLike,
  nowSec: number,
  cfg: ShadowConfig,
  stats: DayStats,
  range: EntryRange = USUAL_ENTRY_RANGE,
  // false = do NOT gate on the card's live price (a ticks MIDPOINT, up to a few seconds old). The taker engine
  // sets this: it gates on the real best ask from the live order book instead (see taker.ts).
  gateOnCardPrice = true,
): Decision {
  if (!cfg.symbols.includes(card.symbol)) return { kind: "ignore" };
  if (!card.hasPrediction || !card.take || !card.lean || card.entry === null) return { kind: "ignore" };

  const ageSec = nowSec - card.windowStartTs;
  if (ageSec < cfg.waitSeconds) return { kind: "defer" };
  if (ageSec > cfg.maxAgeSeconds) return { kind: "record", decision: "skipped", reason: "too_late" };

  // card.take was computed from the price AT WINDOW OPEN and never changes; currentPrice is
  // live. Same reasoning as SignalCard's livePriceMoved check in the app.
  if (gateOnCardPrice) {
    if (card.currentPrice === null) return { kind: "record", decision: "skipped", reason: "no_live_price" };
    if (!isPriceAllowed(card.currentPrice, range)) return { kind: "record", decision: "skipped", reason: "price_out_of_band" };
  }

  if (stats.tradesToday >= cfg.maxTradesPerDay) return { kind: "record", decision: "skipped", reason: "max_trades_per_day" };
  if (stats.realizedPnlUsd <= -cfg.dailyLossLimitUsd) return { kind: "record", decision: "skipped", reason: "daily_loss_limit" };

  return { kind: "need_book" };
}

/** Second stage, once the leaned token's live book has been fetched: prices and sizes the
 * order exactly as the app's real TAKE flow would (computeMakerPrice), then applies the same
 * final band check confirmTake makes right before signing. */
export function sizeDecision(card: CardLike, book: BookInfo, cfg: ShadowConfig, range: EntryRange = USUAL_ENTRY_RANGE): Decision {
  if (card.entry === null) return { kind: "record", decision: "skipped", reason: "sizing_failed" };
  const priced = computeMakerPrice({
    entryPrice: card.entry,
    tickSize: book.tickSize,
    minOrderSize: book.minOrderSize,
    asks: book.asks,
    stakeUsd: cfg.stakeUsd,
  });
  if (!priced.ok) {
    const reason = priced.reason.startsWith("no_room_to_rest")
      ? "no_room_to_rest"
      : priced.reason.startsWith("below_min_order_size")
        ? "below_min_order_size"
        : "sizing_failed";
    return { kind: "record", decision: "skipped", reason };
  }
  if (!isPriceAllowed(priced.limitPrice, range)) {
    return { kind: "record", decision: "skipped", reason: "price_out_of_band_at_sizing" };
  }
  return { kind: "record", decision: "would_place", limitPrice: priced.limitPrice, shares: priced.shares, bestAsk: priced.bestAsk };
}

/** Simulated P&L of a resolved would_place: a filled maker BUY at `price` for `shares`
 * pays 1 per share if the lean was right, else 0. Fees and the chance the order never
 * filled are NOT modelled - this is a first-order shadow number, labelled as such in the UI. */
export function simulatedPnlUsd(price: number, shares: number, win: boolean): number {
  const pnl = win ? shares * (1 - price) : -shares * price;
  return Math.round(pnl * 1e6) / 1e6;
}

/** Reads the worker's tunables from an env-like object, failing loudly on nonsense rather
 * than silently trading (even in shadow) on a default the operator didn't intend. */
export function configFromEnv(env: Record<string, string | undefined>): ShadowConfig {
  const num = (name: string, fallback: number, { int = false, min = 0 } = {}) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) {
      throw new Error(`${name} must be ${int ? "an integer" : "a number"} >= ${min}, got ${JSON.stringify(raw)}.`);
    }
    return n;
  };
  const symbols = (env.SHADOW_SYMBOLS ?? "btc,eth")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!symbols.length || symbols.some((s) => s !== "btc" && s !== "eth")) {
    throw new Error(`SHADOW_SYMBOLS must be a comma list of btc/eth, got ${JSON.stringify(env.SHADOW_SYMBOLS)}.`);
  }
  const stakeUsd = num("SHADOW_STAKE_USD", 5, { min: 0.01 });
  return {
    symbols,
    stakeUsd,
    maxTradesPerDay: num("SHADOW_MAX_TRADES_PER_DAY", 20, { int: true, min: 1 }),
    dailyLossLimitUsd: num("SHADOW_DAILY_LOSS_LIMIT_USD", 25, { min: 0.01 }),
    altRange: parseEntryRange(env.SHADOW_ALT_MIN_CENTS, env.SHADOW_ALT_MAX_CENTS),
    waitSeconds: num("SHADOW_WAIT_SECONDS", DEFAULT_WAIT_SECONDS, { min: 0 }),
    maxAgeSeconds: num("SHADOW_MAX_AGE_SECONDS", DEFAULT_MAX_AGE_SECONDS, { min: 1 }),
  };
}

/** Global kill switch: any of 1/true/yes/on (case-insensitive) halts all decisions. Read
 * from the environment every tick, so a restart with the variable set takes effect at once. */
export function killSwitchOn(env: Record<string, string | undefined>): boolean {
  return /^(1|true|yes|on)$/i.test((env.AUTOTRADE_KILL_SWITCH ?? "").trim());
}
