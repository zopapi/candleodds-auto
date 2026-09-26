// Signals over HTTP from CandleOdds, behind the operator's client token. The worker never sees
// our database URL. 401/403 mean the token was revoked (or lacks the scope): AuthRejected lets
// the engine stop trading immediately instead of retrying blindly.
import type { SignalsResponse } from "./types.ts";

export class AuthRejected extends Error {
  status: number;
  constructor(status: number) {
    super(`CandleOdds rejected the client token (HTTP ${status}).`);
    this.name = "AuthRejected";
    this.status = status;
  }
}

export interface SignalsSource {
  fetch(): Promise<SignalsResponse>;
}

export class HttpSignals implements SignalsSource {
  private url: string;
  private token: string;
  constructor(baseUrl: string, token: string) {
    this.url = `${baseUrl}/api/worker/signals`;
    this.token = token;
  }

  async fetch(): Promise<SignalsResponse> {
    const res = await fetch(this.url, {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) throw new AuthRejected(res.status);
    if (!res.ok) throw new Error(`signals: HTTP ${res.status}`);
    const body = (await res.json()) as SignalsResponse;
    if (!Array.isArray(body.cards) || typeof body.serverTime !== "number" || typeof body.builderCode !== "string") {
      throw new Error("signals: unexpected response shape");
    }
    return body;
  }
}
