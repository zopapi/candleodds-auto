import type { OrderBookLevel } from "../../src/lib/trading.ts";
import type { ActivityEntry, OrderStatusKind } from "../../src/lib/order-status.ts";
import type { CardLike } from "../decision.ts";

/** A signal card as served by GET /api/worker/signals (camelCase, same as the app's own). */
export type Card = CardLike & {
  windowEndTs: number;
  convictionPct: number | null;
  prevWindowStartTs: number | null;
  prevResolved: boolean | null;
  prevWin: boolean | null;
};

export type SignalsResponse = { cards: Card[]; serverTime: number; builderCode: string };

export type WindowDecision = "skipped" | "would_place" | "live_pending" | "live_placed" | "live_failed";

export type WindowRow = {
  symbol: string;
  windowStartTs: number;
  mode: "shadow" | "live";
  decision: WindowDecision;
  reason?: string | null;
  lean?: string | null;
  entry?: number | null;
  currentPrice?: number | null;
  limitPrice?: number | null;
  shares?: number | null;
  stakeUsd?: number | null;
  tokenId?: string | null;
  decidedAtMs: number;
  outcomeWin?: boolean | null;
  pnlUsd?: number | null;
  /** How this window is/was executed: "maker_first" (rest a maker order) or "taker" (fill-and-kill at the ask). */
  execution?: "maker_first" | "taker" | null;
  /** Taker only: the average price actually paid, and the estimated Polymarket taker fee (USD). */
  fillPrice?: number | null;
  feeUsd?: number | null;
};

export type LegRow = {
  symbol: string;
  windowStartTs: number;
  kind: "maker" | "taker";
  orderId: string;
  tokenId: string;
  price: number;
  shares: number;
  placedAtMs: number;
  expiresAtSec: number;
  status: OrderStatusKind;
  filledShares: number;
};

export type DayStats = { tradesToday: number; realizedPnlUsd: number };

export interface Store {
  ensureSchema(): Promise<void>;
  /** Inserts the window if absent. Returns false if a row for (symbol, window) already exists. */
  claimWindow(w: WindowRow): Promise<boolean>;
  getWindow(symbol: string, windowStartTs: number): Promise<WindowRow | undefined>;
  updateWindow(symbol: string, windowStartTs: number, patch: Partial<WindowRow>): Promise<void>;
  addLeg(l: LegRow): Promise<void>;
  updateLeg(orderId: string, patch: Partial<LegRow>): Promise<void>;
  /** Legs whose status is still "resting". */
  openLegs(): Promise<LegRow[]>;
  legsFor(symbol: string, windowStartTs: number): Promise<LegRow[]>;
  /** Trade count (every claim, including failed) and realized P&L for the UTC day of a window. */
  dayStats(windowStartTs: number): Promise<DayStats>;
  /** The window row if it is placed/would_place and not yet resolved. */
  unresolvedWindow(symbol: string, windowStartTs: number): Promise<WindowRow | undefined>;
  /** Live claims older than `olderThanMs` that never reached "placed" (crash between claim and order). */
  staleClaims(olderThanMs: number, nowMs: number): Promise<WindowRow[]>;
  close(): Promise<void>;
}

export type Market = { tokenId: string; tickSize: number; minOrderSize: number };

/** One ask level from the CLOB book. `size` is in shares; it is optional so old fakes and thin books still type-check. */
export type BookLevel = OrderBookLevel & { size?: string | number };

/** Public Polymarket reads (no credentials). Injectable so the lifecycle can be tested. */
export interface MarketData {
  forWindow(symbol: string, windowStartTs: number, lean: string): Promise<Market>;
  asks(tokenId: string): Promise<BookLevel[]>;
  activity(wallet: string): Promise<ActivityEntry[]>;
}

export type PlaceParams = {
  tokenId: string;
  price: number;
  shares: number;
  expirationSec: number;
  builderCode: string;
  postOnly: boolean;
};

/** An immediate fill-and-kill BUY: spend at most `amountUsd` (all-in, fees included) at `maxPrice` or better. */
export type MarketBuyParams = {
  tokenId: string;
  amountUsd: number;
  maxPrice: number;
  builderCode: string;
};

/** What a fill-and-kill order actually got (nothing rests afterwards, so this is final). */
export type MarketBuyResult = { orderId: string; spentUsd: number; shares: number; txHashes: string[] };

/** Everything that needs the wallet's key. */
export interface Trader {
  readonly wallet: string;
  place(p: PlaceParams): Promise<{ orderId: string }>;
  /** Immediate fill-and-kill buy (taker execution). Resolves with 0 shares if nothing matched. */
  marketBuy(p: MarketBuyParams): Promise<MarketBuyResult>;
  /** True only if Polymarket confirmed the order was cancelled. */
  cancel(orderId: string): Promise<boolean>;
  balanceUsd(): Promise<number>;
  /** Are all the trading approvals in place (read-only, on-chain)? */
  approvals(): Promise<{ ok: boolean; missing: number }>;
}

export type ReportKind = "decision" | "order" | "event";
export interface Reporter {
  report(kind: ReportKind, symbol: string | null, windowStartTs: number | null, payload: Record<string, unknown>): void;
}
