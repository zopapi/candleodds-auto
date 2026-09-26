// Pre-flight checks for LIVE mode: everything that must be true before the first real order.
// Each check returns a problem string (or nothing). Pure-ish: I/O is injected so it's testable.
import { evaluateJurisdiction, isFrontendOnlyRestriction } from "../../src/lib/geo-rules.ts";
import type { EngineConfig } from "./config.ts";
import type { Trader } from "./types.ts";

export type Geoblock = { blocked: boolean; country?: string; region?: string; ip?: string };

export type GeoDecision = { allowed: boolean; detail: string };

/**
 * Should THIS server trade, given Polymarket's answer about its IP? A worker is an API client, so
 * it follows the API-level rule (the same one CandleOdds' /api/pm/sign applies), NOT the raw
 * "blocked" flag: that flag also reflects frontend-only restrictions (e.g. the Netherlands is
 * close-only on Polymarket's website, but its API accepts orders). Refuse when:
 *   - the country is unknown (fail closed), or
 *   - the API-level rule blocks it, or
 *   - Polymarket says blocked for a reason our list does not explain as frontend-only (our list
 *     may be out of date, so trust the stricter answer).
 * The detail is written to the log verbatim.
 */
export function evaluateGeoblock(g: Geoblock): GeoDecision {
  if (!g.country) return { allowed: false, detail: "location unknown: Polymarket did not report a country (failing closed)" };
  const where = g.country + (g.region ? "-" + g.region : "");
  const api = evaluateJurisdiction(g.country, g.region ?? null, { apiClient: true });
  if (!api.allowed) return { allowed: false, detail: `location ${where}: not allowed for API trading (${api.reason})` };
  if (g.blocked && !isFrontendOnlyRestriction(g.country)) {
    return { allowed: false, detail: `location ${where}: Polymarket reports it blocked, and that is not a frontend-only restriction we know of (failing closed)` };
  }
  if (g.blocked) {
    return {
      allowed: true,
      detail: `location ${where}: allowed by the API-level rule. Polymarket's frontend flag says blocked, but ${g.country} is close-only on its frontend only; its API accepts orders`,
    };
  }
  return { allowed: true, detail: `location ${where}: allowed (Polymarket reports not blocked)` };
}

/** Polymarket's own answer about THIS server's IP (the one orders will come from). */
export async function fetchGeoblock(fetchFn: typeof fetch = fetch): Promise<Geoblock> {
  const res = await fetchFn("https://polymarket.com/api/geoblock", { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`geoblock check: HTTP ${res.status}`);
  return (await res.json()) as Geoblock;
}

export type PreflightResult = { problems: string[]; notes: string[] };

export async function livePreflight(
  cfg: EngineConfig,
  trader: Trader,
  geoblock: () => Promise<Geoblock>,
): Promise<PreflightResult> {
  const problems: string[] = [];
  const notes: string[] = [];

  // 1. The key must control the wallet the operator expects - never trade from an unexpected one.
  if (trader.wallet.toLowerCase() !== cfg.expectedWallet) {
    problems.push(
      `The key controls wallet ${trader.wallet}, not the AUTOTRADE_EXPECTED_WALLET you set (${cfg.expectedWallet}). ` +
        "Check you exported the key from the right account.",
    );
    return { problems, notes }; // nothing else is meaningful for the wrong wallet
  }
  notes.push(`wallet ${trader.wallet} matches`);

  // 2. Location: Polymarket refuses orders from blocked regions.
  try {
    const decision = evaluateGeoblock(await geoblock());
    if (decision.allowed) notes.push(decision.detail);
    else problems.push(`${decision.detail}. Deploy the worker in Railway's EU West (Amsterdam) region.`);
  } catch (e) {
    problems.push(`Could not check the geoblock: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. Money and permissions.
  try {
    const balance = await trader.balanceUsd();
    if (balance < cfg.stakeUsd) problems.push(`Balance is $${balance.toFixed(2)}, less than one stake ($${cfg.stakeUsd}). Deposit first.`);
    else notes.push(`balance $${balance.toFixed(2)}`);
  } catch (e) {
    problems.push(`Could not read the balance: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const a = await trader.approvals();
    if (!a.ok) problems.push(`The wallet is missing ${a.missing} trading approval(s). Log in to candleodds.com once with this account so it is fully set up, then restart.`);
    else notes.push("trading approvals in place");
  } catch (e) {
    problems.push(`Could not read the trading approvals: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { problems, notes };
}
