// The only module that touches the wallet's private key. It builds the same kind of client the
// CandleOdds app builds (deposit wallet, POLY_1271 signing via the official SDK), with two
// differences that matter for a self-hosted worker:
//   - the signer is a private key held in memory (WALLET_PRIVATE_KEY), not the Privy window;
//   - builder headers come from CandleOdds' /api/pm/sign using the operator's client token, so
//     the worker never holds our builder secret, and its orders carry our builder code.
// Talks to Polymarket's CLOB directly (not through our proxy): the order goes from the
// operator's own server, signed by the operator's own key.
import { createSecureClient, OrderSide, OrderType, remoteBuilderSigning } from "@polymarket/client";
import { fetchBalanceAllowance, fetchTradingApprovalsState } from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";
import type { EngineConfig } from "./config.ts";
import type { MarketBuyParams, PlaceParams, Trader } from "./types.ts";

export async function createSdkTrader(cfg: EngineConfig): Promise<Trader> {
  if (!cfg.privateKey) throw new Error("A private key is required to create the live trader.");

  const client = await createSecureClient({
    signer: privateKey(cfg.privateKey),
    apiKey: remoteBuilderSigning({
      url: `${cfg.candleoddsUrl}/api/pm/sign`,
      headers: { authorization: `Bearer ${cfg.token}` },
    }),
  });
  const wallet = String(client.account.wallet);

  return {
    wallet,

    async place(p: PlaceParams) {
      const res = await client.placeLimitOrder({
        tokenId: p.tokenId,
        side: OrderSide.BUY,
        price: String(p.price),
        size: String(p.shares),
        builderCode: p.builderCode,
        postOnly: p.postOnly,
        expiration: p.expirationSec,
      });
      const orderId = (res as { orderId?: string }).orderId;
      if (!orderId) throw new Error("Order was not accepted (no order id returned).");
      return { orderId };
    },

    // Taker execution: ONE immediate fill-and-kill buy. `amount` is the stake (USD) and `maxSpend`
    // keeps the all-in spend (fees included) within it, so 1R never exceeds the stake; `maxPrice` is
    // the best ask we saw. Anything not matched at once is cancelled by the exchange - nothing rests.
    async marketBuy(p: MarketBuyParams) {
      const res = (await client.placeMarketOrder({
        tokenId: p.tokenId,
        side: OrderSide.BUY,
        amount: String(p.amountUsd),
        maxSpend: String(p.amountUsd),
        maxPrice: String(p.maxPrice),
        builderCode: p.builderCode,
        orderType: OrderType.FAK,
      })) as { ok?: boolean; orderId?: string; makingAmount?: string; takingAmount?: string; transactionsHashes?: string[]; code?: string; message?: string };
      if (res.ok === false || !res.orderId) throw new Error(`Order was not accepted${res.code ? ` (${res.code})` : ""}${res.message ? `: ${res.message}` : ""}`);
      // makingAmount = collateral committed by the fills, takingAmount = shares received (both '0' if nothing matched).
      return {
        orderId: res.orderId,
        spentUsd: Number(res.makingAmount ?? 0) || 0,
        shares: Number(res.takingAmount ?? 0) || 0,
        txHashes: res.transactionsHashes ?? [],
      };
    },

    async cancel(orderId: string) {
      const res = await client.cancelOrder({ orderId } as never);
      return (res as { canceled?: string[] }).canceled?.includes(orderId) === true;
    },

    async balanceUsd() {
      const b = await fetchBalanceAllowance(client, { assetType: "COLLATERAL" } as never);
      return Number((b as { balance: string }).balance) / 1_000_000;
    },

    async approvals() {
      const st = await fetchTradingApprovalsState(client, { user: wallet });
      return { ok: st.isFullyApproved, missing: st.missing.erc20.length + st.missing.erc1155.length };
    },
  };
}
