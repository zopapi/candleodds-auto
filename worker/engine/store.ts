// Storage for the engine. PgStore is the operator's own Postgres (Railway plugin); MemoryStore
// backs the tests. The unique (symbol, window) row is the idempotency guarantee: claimWindow
// happens BEFORE any order is placed, so a restart can never place a window twice.
import postgres from "postgres";
import { utcDayBounds } from "../decision.ts";
import type { DayStats, LegRow, Store, WindowRow } from "./types.ts";

const CLAIMED_STATES = ["would_place", "live_pending", "live_placed", "live_failed"];

export class MemoryStore implements Store {
  windows = new Map<string, WindowRow>();
  legs: LegRow[] = [];
  private key(s: string, t: number) {
    return `${s}:${t}`;
  }
  async ensureSchema() {}
  async claimWindow(w: WindowRow) {
    const k = this.key(w.symbol, w.windowStartTs);
    if (this.windows.has(k)) return false;
    this.windows.set(k, { ...w });
    return true;
  }
  async getWindow(symbol: string, ts: number) {
    return this.windows.get(this.key(symbol, ts));
  }
  async updateWindow(symbol: string, ts: number, patch: Partial<WindowRow>) {
    const k = this.key(symbol, ts);
    const w = this.windows.get(k);
    if (w) this.windows.set(k, { ...w, ...patch });
  }
  async addLeg(l: LegRow) {
    this.legs.push({ ...l });
  }
  async updateLeg(orderId: string, patch: Partial<LegRow>) {
    const i = this.legs.findIndex((l) => l.orderId === orderId);
    if (i >= 0) this.legs[i] = { ...this.legs[i], ...patch };
  }
  async openLegs() {
    return this.legs.filter((l) => l.status === "resting").map((l) => ({ ...l }));
  }
  async legsFor(symbol: string, ts: number) {
    return this.legs.filter((l) => l.symbol === symbol && l.windowStartTs === ts).map((l) => ({ ...l }));
  }
  async dayStats(windowStartTs: number): Promise<DayStats> {
    const { startSec, endSec } = utcDayBounds(windowStartTs);
    const inDay = [...this.windows.values()].filter((w) => w.windowStartTs >= startSec && w.windowStartTs < endSec);
    return {
      tradesToday: inDay.filter((w) => CLAIMED_STATES.includes(w.decision)).length,
      realizedPnlUsd: inDay.reduce((s, w) => s + (w.pnlUsd ?? 0), 0),
    };
  }
  async unresolvedWindow(symbol: string, ts: number) {
    const w = this.windows.get(this.key(symbol, ts));
    const open = w !== undefined && (w.decision === "live_placed" || w.decision === "would_place") && (w.outcomeWin === undefined || w.outcomeWin === null);
    return open ? { ...w } : undefined;
  }
  async staleClaims(olderThanMs: number, nowMs: number) {
    return [...this.windows.values()].filter((w) => w.decision === "live_pending" && nowMs - w.decidedAtMs > olderThanMs).map((w) => ({ ...w }));
  }
  async close() {}
}

type Sql = ReturnType<typeof postgres>;

export class PgStore implements Store {
  private sql: Sql;
  constructor(databaseUrl: string) {
    // The Railway Postgres URL works as-is; TLS is negotiated by the server.
    // onnotice: postgres.js prints server NOTICEs by default, and "create ... if not exists"
    // raises one ("relation ... already exists, skipping", routine index_create) on every start
    // after the first. Harmless, but it looks like an error in the logs, so it is dropped.
    this.sql = postgres(databaseUrl, { max: 3, idle_timeout: 20, connect_timeout: 15, onnotice: () => {} });
  }

  /**
   * Creates the tables/index. Serialized with a transaction-level advisory lock, because
   * "create ... if not exists" is NOT safe when two processes start at once (Railway briefly runs
   * the old and the new deployment side by side, and a crash-looping deploy restarts repeatedly):
   * both see "missing", and one fails inside Postgres (routine index_create) with "already
   * exists". The lock makes concurrent starters take turns, so the second finds everything in
   * place. One retry covers any leftover catalog race.
   */
  async ensureSchema() {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.createSchemaLocked();
        return;
      } catch (e) {
        const code = (e as { code?: string }).code;
        // 42P07 duplicate relation, 23505 unique violation in the catalog, 42710 duplicate object
        if (attempt >= 2 || !(code === "42P07" || code === "23505" || code === "42710")) throw e;
      }
    }
  }

  private async createSchemaLocked() {
    await this.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7272001)`;
    await tx`
      create table if not exists engine_windows (
        symbol          text        not null,
        window_start_ts bigint      not null,
        mode            text        not null,
        decision        text        not null,
        reason          text,
        lean            text,
        entry           numeric,
        current_price   numeric,
        limit_price     numeric,
        shares          numeric,
        stake_usd       numeric,
        token_id        text,
        decided_at_ms   bigint      not null,
        outcome_win     boolean,
        pnl_usd         numeric,
        resolved_at     timestamptz,
        primary key (symbol, window_start_ts)
      )`;
    await tx`
      create table if not exists engine_legs (
        order_id        text        primary key,
        symbol          text        not null,
        window_start_ts bigint      not null,
        kind            text        not null,
        token_id        text        not null,
        price           numeric     not null,
        shares          numeric     not null,
        placed_at_ms    bigint      not null,
        expires_at_sec  bigint      not null,
        status          text        not null,
        filled_shares   numeric     not null default 0
      )`;
    await tx`create index if not exists engine_legs_status_idx on engine_legs (status)`;
    // Added with taker execution; additive, so an existing database upgrades in place.
    await tx`alter table engine_windows add column if not exists execution text`;
    await tx`alter table engine_windows add column if not exists fill_price numeric`;
    await tx`alter table engine_windows add column if not exists fee_usd numeric`;
    });
  }

  async claimWindow(w: WindowRow) {
    const rows = await this.sql`
      insert into engine_windows (symbol, window_start_ts, mode, decision, reason, lean, entry, current_price, limit_price, shares, stake_usd, token_id, decided_at_ms, execution)
      values (${w.symbol}, ${w.windowStartTs}, ${w.mode}, ${w.decision}, ${w.reason ?? null}, ${w.lean ?? null}, ${w.entry ?? null}, ${w.currentPrice ?? null},
              ${w.limitPrice ?? null}, ${w.shares ?? null}, ${w.stakeUsd ?? null}, ${w.tokenId ?? null}, ${w.decidedAtMs}, ${w.execution ?? null})
      on conflict (symbol, window_start_ts) do nothing
      returning symbol`;
    return rows.length > 0;
  }

  private toWindow(r: Record<string, unknown>): WindowRow {
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      symbol: r.symbol as string,
      windowStartTs: Number(r.window_start_ts),
      mode: r.mode as "shadow" | "live",
      decision: r.decision as WindowRow["decision"],
      reason: (r.reason as string | null) ?? null,
      lean: (r.lean as string | null) ?? null,
      entry: n(r.entry),
      currentPrice: n(r.current_price),
      limitPrice: n(r.limit_price),
      shares: n(r.shares),
      stakeUsd: n(r.stake_usd),
      tokenId: (r.token_id as string | null) ?? null,
      decidedAtMs: Number(r.decided_at_ms),
      outcomeWin: (r.outcome_win as boolean | null) ?? null,
      pnlUsd: n(r.pnl_usd),
      execution: (r.execution as WindowRow["execution"]) ?? null,
      fillPrice: n(r.fill_price),
      feeUsd: n(r.fee_usd),
    };
  }

  async getWindow(symbol: string, ts: number) {
    const rows = await this.sql`select * from engine_windows where symbol = ${symbol} and window_start_ts = ${ts}`;
    return rows[0] ? this.toWindow(rows[0]) : undefined;
  }

  async updateWindow(symbol: string, ts: number, p: Partial<WindowRow>) {
    // Only the fields the engine ever changes after the claim.
    await this.sql`
      update engine_windows set
        decision    = coalesce(${p.decision ?? null}, decision),
        reason      = case when ${p.reason === null}::boolean then null else coalesce(${p.reason ?? null}, reason) end, -- null clears it (a watched window that filled)
        limit_price = coalesce(${p.limitPrice ?? null}, limit_price),
        shares      = coalesce(${p.shares ?? null}, shares),
        execution   = coalesce(${p.execution ?? null}, execution),
        fill_price  = coalesce(${p.fillPrice ?? null}::numeric, fill_price),
        fee_usd     = coalesce(${p.feeUsd ?? null}::numeric, fee_usd),
        outcome_win = coalesce(${p.outcomeWin ?? null}::boolean, outcome_win),
        pnl_usd     = coalesce(${p.pnlUsd ?? null}::numeric, pnl_usd),
        resolved_at = case when ${p.outcomeWin ?? null}::boolean is not null then now() else resolved_at end
      where symbol = ${symbol} and window_start_ts = ${ts}`;
  }

  async addLeg(l: LegRow) {
    await this.sql`
      insert into engine_legs (order_id, symbol, window_start_ts, kind, token_id, price, shares, placed_at_ms, expires_at_sec, status, filled_shares)
      values (${l.orderId}, ${l.symbol}, ${l.windowStartTs}, ${l.kind}, ${l.tokenId}, ${l.price}, ${l.shares}, ${l.placedAtMs}, ${l.expiresAtSec}, ${l.status}, ${l.filledShares})
      on conflict (order_id) do nothing`;
  }

  async updateLeg(orderId: string, p: Partial<LegRow>) {
    await this.sql`
      update engine_legs set status = coalesce(${p.status ?? null}, status), filled_shares = coalesce(${p.filledShares ?? null}::numeric, filled_shares)
      where order_id = ${orderId}`;
  }

  private toLeg(r: Record<string, unknown>): LegRow {
    return {
      symbol: r.symbol as string,
      windowStartTs: Number(r.window_start_ts),
      kind: r.kind as "maker" | "taker",
      orderId: r.order_id as string,
      tokenId: r.token_id as string,
      price: Number(r.price),
      shares: Number(r.shares),
      placedAtMs: Number(r.placed_at_ms),
      expiresAtSec: Number(r.expires_at_sec),
      status: r.status as LegRow["status"],
      filledShares: Number(r.filled_shares),
    };
  }

  async openLegs() {
    return (await this.sql`select * from engine_legs where status = 'resting' order by placed_at_ms`).map((r) => this.toLeg(r));
  }

  async legsFor(symbol: string, ts: number) {
    return (await this.sql`select * from engine_legs where symbol = ${symbol} and window_start_ts = ${ts} order by placed_at_ms`).map((r) => this.toLeg(r));
  }

  async dayStats(windowStartTs: number): Promise<DayStats> {
    const { startSec, endSec } = utcDayBounds(windowStartTs);
    const [row] = await this.sql`
      select
        count(*) filter (where decision in ('would_place','live_pending','live_placed','live_failed'))::int as trades,
        coalesce(sum(pnl_usd), 0)::float8 as pnl
      from engine_windows where window_start_ts >= ${startSec} and window_start_ts < ${endSec}`;
    return { tradesToday: Number(row.trades), realizedPnlUsd: Number(row.pnl) };
  }

  async unresolvedWindow(symbol: string, ts: number) {
    const rows = await this.sql`
      select * from engine_windows
      where symbol = ${symbol} and window_start_ts = ${ts} and decision in ('live_placed','would_place') and outcome_win is null`;
    return rows[0] ? this.toWindow(rows[0]) : undefined;
  }

  async staleClaims(olderThanMs: number, nowMs: number) {
    const rows = await this.sql`select * from engine_windows where decision = 'live_pending' and ${nowMs}::bigint - decided_at_ms > ${olderThanMs}`;
    return rows.map((r) => this.toWindow(r));
  }

  async close() {
    await this.sql.end({ timeout: 3 });
  }
}
