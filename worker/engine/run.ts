// Runner for the self-hosted engine (AUTOTRADE_MODE=live, or shadow with a client token).
// Startup is fail-fast and loud: a misconfiguration exits with a clear message instead of
// trading on a guess. Nothing here prints the private key or the token.
import { killSwitchOn } from "../decision.ts";
import { loadEngineConfig } from "./config.ts";
import { Engine } from "./engine.ts";
import { HttpMarketData } from "./market.ts";
import { evaluateGeoblock, fetchGeoblock, livePreflight } from "./preflight.ts";
import { HttpReporter } from "./report.ts";
import { AuthRejected, HttpSignals } from "./source.ts";
import { PgStore } from "./store.ts";
import { createSdkTrader } from "./trader.ts";
import type { Trader } from "./types.ts";

const GEOBLOCK_RECHECK_MS = 60 * 60 * 1000;
const ALIVE_LOG_MS = 5 * 60 * 1000; // a "still running" line every 5 minutes

function log(msg: string, extra?: Record<string, unknown>) {
  console.log(`${new Date().toISOString()} ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
}

function die(msg: string): never {
  console.error(`\nSTOP: ${msg}\n`);
  process.exit(1);
}

export async function run(mode: "shadow" | "live"): Promise<void> {
  let cfg;
  try {
    cfg = loadEngineConfig(process.env, mode);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }

  log(
    mode === "live"
      ? "CandleOdds worker starting in LIVE mode - it WILL place real orders"
      : "CandleOdds worker starting in SHADOW mode - it records what it would do and places nothing",
    {
      execution: cfg.execution,
      stakeUsd: cfg.stakeUsd,
      maxTradesPerDay: cfg.rules.maxTradesPerDay,
      dailyLossLimitUsd: cfg.rules.dailyLossLimitUsd,
      range: `${cfg.range.minCents}-${cfg.range.maxCents}c`,
      symbols: cfg.rules.symbols,
      makerFillTimeoutSeconds: cfg.makerFillTimeoutSeconds,
    },
  );
  // One plain-English line saying exactly how orders will be sent (also the first thing to check in the logs).
  log(
    cfg.execution === "taker"
      ? `execution mode: TAKER - fill-and-kill at the real best ask from a fresh order book, capped at min(ask + ${cfg.takerSlippageCents}c, ${cfg.range.maxCents}c); up to ${cfg.takerMaxAttempts} attempts within ${cfg.takerRetryWindowSeconds}s of the decision (a no-fill is retried, a fill never is); nothing ever rests, every fill pays the taker fee`
      : `execution mode: MAKER_FIRST - a resting maker order, converted to a taker order after ${cfg.makerFillTimeoutSeconds}s if unfilled and still in range`,
    cfg.execution === "taker"
      ? { execution: cfg.execution, takerSlippageCents: cfg.takerSlippageCents, takerMaxAttempts: cfg.takerMaxAttempts, takerRetryWindowSeconds: cfg.takerRetryWindowSeconds }
      : { execution: cfg.execution },
  );

  const store = new PgStore(cfg.databaseUrl);
  try {
    await store.ensureSchema();
  } catch (e) {
    die(`Could not use DATABASE_URL: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The token must work before anything else happens.
  const source = new HttpSignals(cfg.candleoddsUrl, cfg.token);
  try {
    const first = await source.fetch();
    log("signals endpoint reachable", { cards: first.cards.length });
  } catch (e) {
    die(e instanceof AuthRejected ? "CandleOdds rejected CANDLEODDS_TOKEN (revoked or wrong). Ask CandleOdds for a new token." : `Could not reach CandleOdds signals: ${e instanceof Error ? e.message : String(e)}`);
  }

  let trader: Trader | undefined;
  let geoBlocked = false;
  if (mode === "live") {
    try {
      trader = await createSdkTrader(cfg);
    } catch (e) {
      die(
        `Could not set up the trading client: ${e instanceof Error ? e.message : String(e)}\n` +
          "If this wallet has never been used, log in to candleodds.com with the same account once first (that deploys and approves it), then restart.",
      );
    }
    const pre = await livePreflight(cfg, trader!, fetchGeoblock);
    for (const n of pre.notes) log(`preflight ok: ${n}`);
    if (pre.problems.length) die("Pre-flight failed:\n - " + pre.problems.join("\n - "));
  }

  const reporter = new HttpReporter(cfg.candleoddsUrl, cfg.token, { mode, wallet: trader?.wallet ?? null, engine: "v1", execution: cfg.execution });
  reporter.report("event", null, null, {
    event: "started",
    execution: cfg.execution,
    stakeUsd: cfg.stakeUsd,
    maxTradesPerDay: cfg.rules.maxTradesPerDay,
    dailyLossLimitUsd: cfg.rules.dailyLossLimitUsd,
    range: cfg.range,
  });

  const engine = new Engine({
    cfg,
    store,
    market: new HttpMarketData(),
    source,
    reporter,
    trader,
    nowMs: () => Date.now(),
    killSwitch: () => killSwitchOn(process.env) || geoBlocked,
    log,
  });

  // Live: re-check the location hourly. If this server becomes blocked, act like the kill switch.
  let lastGeo = Date.now();
  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      log(`${sig} received, stopping after the current tick (resting orders are left in place; they expire on their own)`);
      stopping = true;
      setTimeout(() => process.exit(0), 8000).unref();
    });
  }

  let ticks = 0;
  let lastAlive = Date.now();
  while (!stopping) {
    if (Date.now() - lastAlive >= ALIVE_LOG_MS) {
      lastAlive = Date.now();
      log("alive", { mode, ticks });
    }
    if (mode === "live" && Date.now() - lastGeo > GEOBLOCK_RECHECK_MS) {
      lastGeo = Date.now();
      try {
        // Same API-level decision as the pre-flight, and what it decided is always logged.
        const decision = evaluateGeoblock(await fetchGeoblock());
        log("hourly location check", { allowed: decision.allowed, detail: decision.detail });
        if (decision.allowed === geoBlocked) log(decision.allowed ? "location allowed again - resuming" : "LOCATION NOT ALLOWED - halting trading");
        geoBlocked = !decision.allowed;
      } catch {
        /* keep the last known state */
      }
    }
    await engine.tick();
    ticks += 1;
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
  await store.close();
}
