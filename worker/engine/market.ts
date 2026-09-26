// Public Polymarket reads used by the engine (no credentials): the window's market (Gamma), the
// order book (CLOB), and the wallet's public fill history (data API). The engine deliberately
// does NOT use Polymarket's authenticated order-lookup endpoints: they return nothing for
// deposit-wallet accounts, which is why fills come from the public feed (see order-status.ts).
import type { ActivityEntry } from "../../src/lib/order-status.ts";
import type { BookLevel, Market, MarketData } from "./types.ts";

const TIMEOUT_MS = 8000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${new URL(url).hostname}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export class HttpMarketData implements MarketData {
  async forWindow(symbol: string, windowStartTs: number, lean: string): Promise<Market> {
    const slug = `${symbol}-updown-15m-${windowStartTs}`;
    const m = (await getJson<{ outcomes: string; clobTokenIds: string; orderPriceMinTickSize: number; orderMinSize: number }[]>(
      `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`,
    ))[0];
    if (!m) throw new Error(`no market for ${slug}`);
    const outcomes = JSON.parse(m.outcomes) as string[];
    const tokens = JSON.parse(m.clobTokenIds) as string[];
    const i = outcomes.indexOf(lean);
    if (i < 0) throw new Error(`outcome ${lean} not found for ${slug}`);
    return { tokenId: tokens[i], tickSize: Number(m.orderPriceMinTickSize), minOrderSize: Number(m.orderMinSize) };
  }

  async asks(tokenId: string): Promise<BookLevel[]> {
    // The real CLOB book, straight from the exchange (never a cached or midpoint price). Sizes are kept so the
    // engine can log what was actually available at and below its cap.
    const b = await getJson<{ asks?: { price: string; size?: string }[] }>(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
    return b.asks ?? [];
  }

  async activity(wallet: string): Promise<ActivityEntry[]> {
    return getJson<ActivityEntry[]>(`https://data-api.polymarket.com/activity?user=${wallet}&type=TRADE&limit=200`);
  }
}
