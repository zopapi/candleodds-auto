// Pure jurisdiction rules (no server-only import, so they can be unit-tested with plain Node -
// scripts/test-geo.mjs). Re-exported by geo.ts, which adds the request/IP plumbing.

/**
 * Geo policy, from https://docs.polymarket.com/api-reference/geoblock (checked 2026-09-21).
 *
 * We refuse anything Polymarket refuses for NEW orders: fully blocked jurisdictions and
 * both close-only tiers. Codes are ISO 3166-1 (country) or "CC-REGION" (ISO 3166-2).
 * Re-check this list against the docs periodically; it changes.
 */
const BLOCKED_COUNTRIES = new Set([
  // Fully blocked (OFAC)
  "IR", "SY", "CU", "KP",
  // Close-only on frontend + API
  "AU", "BY", "BE", "BI", "BR", "CF", "CD", "ET", "FR", "DE", "IQ", "IT", "LB", "LY",
  "MM", "NZ", "NI", "PL", "RU", "SG", "SO", "SK", "SS", "SD", "TW", "TH", "GB", "US",
  "UM", "VE", "YE", "ZW",
]);

// Close-only on Polymarket's FRONTEND only (its API allows them). The browser app is a
// frontend, so it blocks these; a self-hosted worker calling the API with a client token is
// not, so it follows the API-level rule (see evaluateJurisdiction's apiClient option).
const FRONTEND_ONLY_BLOCKED_COUNTRIES = new Set(["IE", "JP", "MT", "NL", "KR"]);

/** Is this country restricted by Polymarket on its FRONTEND only (its API still allows orders)? */
export function isFrontendOnlyRestriction(countryRaw: string | null | undefined): boolean {
  return FRONTEND_ONLY_BLOCKED_COUNTRIES.has((countryRaw ?? "").trim().toUpperCase());
}

const BLOCKED_REGIONS = new Set([
  "CA-BC", "CA-ON", "CA-AB", "CA-QC",
  "UA-43", "UA-14", "UA-09",
]);

// Countries where restrictions are sub-national. If we are in one of these and do not
// know the region, we cannot decide, so we refuse (fail closed).
const REGION_REQUIRED_COUNTRIES = new Set(["CA", "UA"]);

function normalizeRegion(country: string, region: string | null | undefined): string | undefined {
  if (!region) return undefined;
  const upper = decodeURIComponent(region).trim().toUpperCase();
  if (!upper) return undefined;
  return upper.startsWith(`${country}-`) ? upper.slice(country.length + 1) : upper;
}

export function evaluateJurisdiction(
  countryRaw: string | null | undefined,
  regionRaw: string | null | undefined,
  opts: { apiClient?: boolean } = {},
): { allowed: boolean; reason: string; country?: string; region?: string } {
  const country = countryRaw?.trim().toUpperCase();
  if (!country || !/^[A-Z]{2}$/.test(country)) {
    return { allowed: false, reason: "Could not determine your country (failing closed)." };
  }
  const region = normalizeRegion(country, regionRaw);
  if (BLOCKED_COUNTRIES.has(country) || (!opts.apiClient && FRONTEND_ONLY_BLOCKED_COUNTRIES.has(country))) {
    return { allowed: false, reason: `Trading is not available in ${country}.`, country, region };
  }
  if (REGION_REQUIRED_COUNTRIES.has(country) && !region) {
    return {
      allowed: false,
      reason: `Could not determine your region within ${country} (failing closed).`,
      country,
    };
  }
  if (region && BLOCKED_REGIONS.has(`${country}-${region}`)) {
    return {
      allowed: false,
      reason: `Trading is not available in ${country}-${region}.`,
      country,
      region,
    };
  }
  return { allowed: true, reason: "ok", country, region };
}
