# CandleOdds Auto worker (v1.0.1)

The self-hosted bot behind CandleOdds **Auto**: it trades the CandleOdds BTC/ETH 15-minute TAKE signals on Polymarket for
one member's wallet, from **the member's own Railway account, with the member's own key**. CandleOdds never receives the key.

- **Set up:** members start at https://www.candleodds.com/auto/setup (request access, get a token, deploy the Railway template).
- **Operate:** [OPERATOR-GUIDE.md](OPERATOR-GUIDE.md) - what it does, every setting, how to pause and stop.

## What is (and isn't) in here

- The execution engine: timing guards, price range, order placement (maker-first or taker), daily limits, kill switch.
- **Not** the signal model: the worker reads the live signals from CandleOdds with the member's access token.
- **No secrets.** The member supplies `CANDLEODDS_TOKEN`, `AUTOTRADE_EXPECTED_WALLET` and `WALLET_PRIVATE_KEY` as Railway variables.

## Releases

Each release is a git tag `vX.Y.Z`. Pushing the tag builds the container image `ghcr.io/zopapi/candleodds-auto:vX.Y.Z`
once (.github/workflows/release.yml; an existing version is never rebuilt or overwritten). The Railway template pins one
version, so a deployed bot never changes by itself: to update, change the image tag in Railway -> service -> Settings -> Source.
