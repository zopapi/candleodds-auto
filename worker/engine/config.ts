// Configuration for the self-hosted engine (live and client-shadow modes). Pure: reads an
// env-like object, validates strictly, and NEVER puts the private key into an error message.
import { parseEntryRange, type EntryRange } from "../../src/lib/trading.ts";
import { DEFAULT_MAX_AGE_SECONDS, DEFAULT_WAIT_SECONDS, type ShadowConfig } from "../decision.ts";
import type { ExecutionMode } from "./taker.ts";

export const LIVE_CONFIRM_PHRASE = "yes-place-real-orders";
export const DEFAULT_CANDLEODDS_URL = "https://www.candleodds.com";

export type EngineConfig = {
  mode: "shadow" | "live";
  candleoddsUrl: string;
  token: string;
  databaseUrl: string;
  /** Live only. Held in memory, never logged, never reported. */
  privateKey?: string;
  expectedWallet?: string;
  /** Guardrail settings in the shape the shared decision logic expects. */
  rules: ShadowConfig;
  range: EntryRange;
  stakeUsd: number;
  maxStakeUsd: number;
  /** maker_first (default): rest a maker order, then fill-now after the timeout. taker: fill-and-kill at the best ask. */
  execution: ExecutionMode;
  /** Taker only: the cap is min(best ask + this, ENTRY_MAX_CENTS). Default 1 cent. */
  takerSlippageCents: number;
  /** Taker only: at most this many fill-and-kill attempts per window (a no-fill cannot double-fill). Default 3. */
  takerMaxAttempts: number;
  /** Taker only: retries stop this many seconds after the decision. Default 20. */
  takerRetryWindowSeconds: number;
  makerFillTimeoutSeconds: number;
  orderTtlSeconds: number;
  pollMs: number;
};

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function loadEngineConfig(env: Record<string, string | undefined>, mode: "shadow" | "live"): EngineConfig {
  const problems: string[] = [];
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) problems.push(`${name} is required.`);
    return v ?? "";
  };
  const num = (name: string, fallback: number, opts: { int?: boolean; min?: number; max?: number } = {}): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    const min = opts.min ?? 0;
    if (!Number.isFinite(n) || n < min || (opts.max !== undefined && n > opts.max) || (opts.int && !Number.isInteger(n))) {
      problems.push(`${name} must be ${opts.int ? "a whole number" : "a number"} >= ${min}${opts.max !== undefined ? ` and <= ${opts.max}` : ""}.`);
      return fallback;
    }
    return n;
  };

  const token = need("CANDLEODDS_TOKEN");
  const databaseUrl = need("DATABASE_URL");
  const candleoddsUrl = (env.CANDLEODDS_URL?.trim() || DEFAULT_CANDLEODDS_URL).replace(/\/+$/, "");
  if (!/^https:\/\//.test(candleoddsUrl) && !/^http:\/\/localhost(:\d+)?$/.test(candleoddsUrl)) {
    problems.push("CANDLEODDS_URL must be an https:// address.");
  }

  const symbols = (env.AUTOTRADE_SYMBOLS ?? "btc,eth")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!symbols.length || symbols.some((s) => s !== "btc" && s !== "eth")) problems.push("AUTOTRADE_SYMBOLS must be a comma list of btc/eth.");

  const stakeUsd = num("AUTOTRADE_STAKE_USD", 5, { min: 0.01 });
  const maxStakeUsd = num("AUTOTRADE_MAX_STAKE_USD", 25, { min: 0.01 });
  if (stakeUsd > maxStakeUsd) problems.push(`AUTOTRADE_STAKE_USD ($${stakeUsd}) is above AUTOTRADE_MAX_STAKE_USD ($${maxStakeUsd}).`);

  let range: EntryRange = { minCents: 50, maxCents: 60 };
  try {
    // The client engine defaults to the usual 50-60c range (the app's own default has no lower
    // limit because a human confirms "Take anyway"; an automatic trader should opt in to that).
    range = parseEntryRange(env.ENTRY_MIN_CENTS ?? "50", env.ENTRY_MAX_CENTS);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }

  const rules: ShadowConfig = {
    symbols,
    stakeUsd,
    maxTradesPerDay: num("AUTOTRADE_MAX_TRADES_PER_DAY", 50, { int: true, min: 1 }),
    dailyLossLimitUsd: num("AUTOTRADE_DAILY_LOSS_LIMIT_USD", 100, { min: 0.01 }),
    waitSeconds: num("AUTOTRADE_WAIT_SECONDS", DEFAULT_WAIT_SECONDS, { min: 0 }),
    maxAgeSeconds: num("AUTOTRADE_MAX_AGE_SECONDS", DEFAULT_MAX_AGE_SECONDS, { min: 1 }),
    altRange: range, // unused by the engine (it runs one rule); kept for the shared type
  };

  const executionRaw = (env.AUTOTRADE_EXECUTION?.trim() || "maker_first").toLowerCase();
  if (executionRaw !== "maker_first" && executionRaw !== "taker") {
    problems.push(`AUTOTRADE_EXECUTION must be maker_first or taker, got ${JSON.stringify(env.AUTOTRADE_EXECUTION)}.`);
  }
  const execution: ExecutionMode = executionRaw === "taker" ? "taker" : "maker_first";
  // Read (and validated) BEFORE the problems check below, so a bad value is refused, never silently defaulted.
  const takerSlippageCents = num("TAKER_SLIPPAGE_CENTS", 1, { min: 0, max: 10 });
  const takerMaxAttempts = num("TAKER_MAX_ATTEMPTS", 3, { int: true, min: 1, max: 5 });
  const takerRetryWindowSeconds = num("TAKER_RETRY_WINDOW_SECONDS", 20, { min: 1, max: 120 });

  let privateKey: string | undefined;
  let expectedWallet: string | undefined;
  if (mode === "live") {
    privateKey = env.WALLET_PRIVATE_KEY?.trim();
    if (!privateKey) problems.push("WALLET_PRIVATE_KEY is required in live mode.");
    else if (!HEX_KEY.test(privateKey)) problems.push("WALLET_PRIVATE_KEY must be the exported key: 0x followed by 64 hex characters."); // never echo the value
    expectedWallet = env.AUTOTRADE_EXPECTED_WALLET?.trim();
    if (!expectedWallet) problems.push("AUTOTRADE_EXPECTED_WALLET is required in live mode (your trading wallet address from the Wallet screen).");
    else if (!ADDRESS.test(expectedWallet)) problems.push("AUTOTRADE_EXPECTED_WALLET must be a 0x wallet address.");
    if (env.AUTOTRADE_LIVE_CONFIRM?.trim() !== LIVE_CONFIRM_PHRASE) {
      problems.push(`Live mode places REAL orders. Set AUTOTRADE_LIVE_CONFIRM=${LIVE_CONFIRM_PHRASE} to confirm you mean it.`);
    }
  }

  if (problems.length) throw new Error("Configuration problems:\n - " + problems.join("\n - "));

  return {
    mode,
    candleoddsUrl,
    token,
    databaseUrl,
    privateKey,
    expectedWallet: expectedWallet?.toLowerCase(),
    rules,
    range,
    stakeUsd,
    maxStakeUsd,
    execution,
    takerSlippageCents,
    takerMaxAttempts,
    takerRetryWindowSeconds,
    makerFillTimeoutSeconds: num("MAKER_FILL_TIMEOUT_SECONDS", 45, { int: true, min: 1 }),
    orderTtlSeconds: num("ORDER_TTL_SECONDS", 360, { int: true, min: 1 }),
    pollMs: num("AUTOTRADE_POLL_MS", 3000, { int: true, min: 500 }),
  };
}
