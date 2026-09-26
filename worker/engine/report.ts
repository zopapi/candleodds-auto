// Reports the engine's decisions, orders and lifecycle events back to CandleOdds (the operator
// agreed to this; the operator guide says so). Strictly best-effort: a failure to report must
// never affect trading, so errors are swallowed (logged at most once a minute) and nothing is
// awaited by the caller. Payloads contain only trading facts - never a key or a token.
import type { ReportKind, Reporter } from "./types.ts";

export class HttpReporter implements Reporter {
  private url: string;
  private token: string;
  private extra: Record<string, unknown>;
  private lastWarn = 0;
  constructor(baseUrl: string, token: string, extra: Record<string, unknown>) {
    this.url = `${baseUrl}/api/worker/report`;
    this.token = token;
    this.extra = extra;
  }

  report(kind: ReportKind, symbol: string | null, windowStartTs: number | null, payload: Record<string, unknown>): void {
    void fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ kind, symbol, windowStartTs, payload: { ...this.extra, ...payload } }),
      signal: AbortSignal.timeout(8000),
    })
      .then((res) => {
        if (!res.ok) this.warn(`report rejected: HTTP ${res.status}`);
      })
      .catch((e) => this.warn(`report failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  private warn(msg: string) {
    if (Date.now() - this.lastWarn > 60_000) {
      this.lastWarn = Date.now();
      console.warn(`${new Date().toISOString()} [report] ${msg}`);
    }
  }
}

export class NoopReporter implements Reporter {
  events: { kind: ReportKind; symbol: string | null; windowStartTs: number | null; payload: Record<string, unknown> }[] = [];
  report(kind: ReportKind, symbol: string | null, windowStartTs: number | null, payload: Record<string, unknown>): void {
    this.events.push({ kind, symbol, windowStartTs, payload });
  }
}
