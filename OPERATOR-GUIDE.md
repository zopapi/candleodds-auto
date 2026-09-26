# CandleOdds self-hosted worker: operator guide

This worker trades the CandleOdds BTC/ETH 15-minute signals **automatically, from your own
Railway account, with your own key**. You run it; CandleOdds never sees your key.

Read section 1 first. It says exactly what you are agreeing to.

---

## 1. What you should know before you start

**What the worker does.** When CandleOdds' signal function says a window is a TAKE, the worker
places a real order on Polymarket for your wallet, using the same rules as the CandleOdds app:

- it waits **10 seconds** after the window opens (some signals are revoked in the first seconds);
- it ignores a TAKE seen more than **3 minutes** after the window opened;
- it only trades while the live price is inside the allowed range (**50 to 60 cents** by default);
- it places a **maker order** first (a resting limit order that never crosses the spread);
- if the order is still unfilled after **45 seconds**, it cancels it and buys the **remaining**
  shares at the current best price ("fill now"), but only while the price is still in range;
  if the price has moved out of range, the maker order simply keeps resting;
- it stops for the day at your **trade limit** or **loss limit**, and on the **kill switch**.

**What CandleOdds can see (you agree to this by running the worker).** The worker reports back
to CandleOdds, so we can support you and check it behaves:

- every decision (trade placed or skipped, and why), with the coin, window, direction, prices and size;
- every order event (placed, filled, cancelled, converted, expired), with order id, price, size, fills;
- results (win/loss and profit/loss per window);
- lifecycle events (started, kill switch on/off, token rejected, errors);
- your trading wallet address, and that the worker is running.

**What CandleOdds can never see.** Your private key. It lives only in your Railway variables and
in the worker's memory. It is never sent to CandleOdds and never appears in the worker's logs
or reports.

**What CandleOdds controls.** Your worker uses an **access token** that CandleOdds issued and can
**revoke at any time**. It is used for two things: reading the signals, and getting the
"builder headers" that make your orders carry CandleOdds' builder code (which is how the CandleOdds
fee, currently a **0.5% maker fee**, is charged). CandleOdds' builder secret is never given to you.
If the token is revoked, your worker cancels its resting orders and stops trading within seconds.
The token can only be used for your one registered wallet, and can never move funds or change
permissions.

**Risk.** Trading can lose money, including everything you put in. Past results do not guarantee
future ones. The exported key gives **full control of the wallet**: anyone who obtains it (including
through your Railway account) can take the funds. Only fund the wallet with an amount you can afford to
lose, and protect your Railway account (strong password, 2-factor authentication).

---

## 2. What you need

1. **A CandleOdds account with the Auto membership and a funded, set-up wallet.** Log in at https://www.candleodds.com with
   your email once, open **Wallet**, and deposit USDC on Polygon to the **deposit address** shown there. Logging in once
   deploys and approves your trading wallet; the worker cannot do that for you.
2. **Approved Auto access and your access token.** Open https://www.candleodds.com/auto/setup, tap **Request Auto access**
   and wait for CandleOdds to approve it. The same page then shows your **token** (starts with `cot_`, shown once) and
   your **trading wallet address**. The token is tied to that wallet.
3. **A Railway account on the Hobby plan** (about $5 a month). The free trial can't keep the worker restarting on its own.
   Turn on two-factor authentication: your key will live in this account.

The worker code is public (`zopapi/candleodds-auto`), so you can read exactly what runs with your key. It holds no
CandleOdds secrets and no signal logic: it reads the signals from CandleOdds with your token.

---

## 3. Get your wallet address and export your key

1. Your trading wallet address is on **/auto/setup** (step 2), and also on **Wallet**, under **Your trading wallet**
   (starts with `0x`). This is your `AUTOTRADE_EXPECTED_WALLET`. It is the wallet that holds your balance.
2. Open **Wallet → Security → Export private key**. Tick the confirmation box and tap **Show my key**. A secure Privy
   window opens and shows your key (`0x` followed by 64 characters). The key is shown only in that window; CandleOdds'
   app and servers never receive it.
3. Copy the key and paste it **directly into Railway's `WALLET_PRIVATE_KEY` field** (section 4). Do not paste it
   anywhere else: not into chat, email or a document. Close the window afterwards.

Note: the key you export is the *owner* key. Its own address (shown as "Owner address" under Security) is **not** your
trading account. Never send funds to it.

---

## 4. Deploy with the Railway template (recommended)

1. On **/auto/setup**, tap **Deploy on Railway**. Railway opens the CandleOdds Auto template in your own account.
2. Railway asks for three values. Fill in exactly these, and nothing else:
   - `CANDLEODDS_TOKEN`: your token from /auto/setup (`cot_...`).
   - `AUTOTRADE_EXPECTED_WALLET`: your trading wallet address from /auto/setup.
   - `WALLET_PRIVATE_KEY`: your exported key (section 3).
3. Tap **Deploy**. Railway creates two services in the **EU West (Amsterdam)** region: the worker, and a PostgreSQL
   database (the worker's memory, so a restart never trades a window twice). The worker has no public address.
   Check the worker's **Settings**: region **EU West (Amsterdam)** and restart policy **Always**. Change them there if
   not (Polymarket refuses orders from some regions).
4. Everything else is preset to the pilot values: **shadow mode** (no real orders), taker execution, $5 per trade
   (`AUTOTRADE_MAX_STAKE_USD=5` as a hard cap), at most 50 trades and $100 of losses per UTC day, entry range 0-60 cents,
   restart policy **Always**. Section 5 describes every variable.
5. Check the logs (section 4.1), then go live (section 6).

**What the template runs.** A fixed release of the public worker code, as a container image
(`ghcr.io/zopapi/candleodds-auto:<version>`). It never updates by itself. To update, CandleOdds tells you the new version;
you change the image tag in Railway → worker service → **Settings → Source**, and redeploy. Your variables, database and
state are kept.

### 4.1 Check the logs

Open the worker service, then **Deployments**, then **View logs**. You should see, in order:

- `start: APP_ROLE=(unset, using the default) -> worker/main.ts`
- `CandleOdds worker starting in SHADOW mode` (or `LIVE mode` later)
- `signals endpoint reachable`
- in live mode, `preflight ok: ...` lines (wallet matches, location ok, balance, approvals)
- `execution mode: MAKER_FIRST ...` or `execution mode: TAKER ...` (how orders will be sent, section 5a)
- then an `alive {...}` line every 5 minutes, and a `decision {...}` line whenever a TAKE is skipped (a few TAKEs a day)
- when a trade is placed: `ORDER PLACED {...}`; when it fills: `ORDER FILLED {...}` (or `ORDER PARTIAL FILL`).
  In taker mode there is a single line instead: `TAKER ORDER FILLED {...}`. Every one of these lines shows the
  `execution` mode, the `fillPrice`, the `feeUsd` and (taker) the `allInUsd`.

If something is wrong the worker prints `STOP:` and a plain-English reason, then exits. /auto/setup (step 5) also shows
whether CandleOdds can see your worker and whether it is in shadow or live mode.

---

## 4b. Manual deploy (fallback, without the template)

Use this only if the template (section 4) is unavailable. The worker code is the public repository
`zopapi/candleodds-auto`: deploy the release tag CandleOdds tells you to use.

Railway is retiring "Config as Code": a new service cannot read a `railway.json` from the repository, so **every setting
below is entered in the Railway dashboard**. Railway's screens change occasionally; the names may differ slightly.

### 4b.1 Create the project and the database

1. In Railway, **New Project**, then **Deploy from GitHub repo**, and pick `zopapi/candleodds-auto`.
   (Authorize Railway's GitHub access if asked.) Do **not** add a public domain: the worker has no web interface.
   The first deploy will fail or crash until the settings below are in. That is expected.
2. In the project, click **New**, then **Database**, then **Add PostgreSQL**. This is the worker's memory: it stores its
   decisions and orders, so a restart can never trade a window twice.

### 4b.2 Service settings (worker service, then **Settings**)

| Setting (where) | Value |
|---|---|
| **Custom Build Command** (Build) | `npm ci --omit=dev` |
| **Custom Start Command** (Deploy) | `node start.mjs` |
| **Restart Policy** (Deploy) | **Always** |
| **Region** (Deploy) | **EU West (Amsterdam)**. Polymarket refuses orders from some regions; Amsterdam works. |
| **Watch Paths** (Build) | `/worker/**`, `/src/**`, `/start.mjs`, `/package.json`, `/package-lock.json` (so only a change to the code redeploys it; editing this guide does not) |
| **Public networking** | none: leave "Generate Domain" alone |

Notes:

- `start.mjs` is the entry point. It runs the worker when the variable `APP_ROLE` is **unset** or set to `worker`. Leave
  it unset. Any other value makes it stop with a clear message rather than start something else.
- The build needs a `package-lock.json` in the repository (it is included). Do not delete it.
- After changing a setting, click **Deploy** (the changes show as staged until you do).

### 4b.3 Variables (worker service, then **Variables**)

1. Open **Raw Editor**, and paste the contents of `railway-variables.env` from this repository (the pilot values are
   filled in). Replace the four placeholders: `CANDLEODDS_TOKEN`, `AUTOTRADE_EXPECTED_WALLET`, `WALLET_PRIVATE_KEY`, and
   `DATABASE_URL` (already a reference to the Postgres service; if the service is not named `Postgres`, fix the name).
2. Mark `WALLET_PRIVATE_KEY` and `CANDLEODDS_TOKEN` as sealed/secret if Railway offers it.
3. Every variable is described in section 5.
4. The file starts in **shadow mode** (`AUTOTRADE_MODE=shadow`): read the logs (below), then go live (section 6).

### 4b.4 Check the logs

As in section 4.1.

---

## 5. Every environment variable

Set these in Railway → your worker service → Variables.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `AUTOTRADE_MODE` | no | `shadow` | `shadow` records what it would do and places nothing. `live` places **real orders**. |
| `AUTOTRADE_LIVE_CONFIRM` | live only | none | Must be exactly `yes-place-real-orders`. A safety catch so live mode is never an accident. |
| `WALLET_PRIVATE_KEY` | live only | none | Your exported owner key (`0x` + 64 hex characters). **Secret.** From section 3. |
| `AUTOTRADE_EXPECTED_WALLET` | live only | none | Your trading wallet address from the Wallet screen. The worker refuses to start if the key does not control this wallet. |
| `CANDLEODDS_TOKEN` | yes | none | Your access token from CandleOdds (`cot_...`). **Secret.** |
| `DATABASE_URL` | yes | none | Your Railway Postgres connection (use a reference to the Postgres service). The worker creates its own tables. |
| `CANDLEODDS_URL` | no | `https://www.candleodds.com` | Where signals and reporting are fetched from. Leave as is. |
| `APP_ROLE` | no | unset | Leave **unset** (or `worker`). `start.mjs` refuses any other value. |
| `AUTOTRADE_STAKE_USD` | no | `5` | Dollars per trade. |
| `AUTOTRADE_MAX_STAKE_USD` | no | `25` | A hard cap: the worker refuses to start if the stake is above it. **For the pilot set this to `5`.** |
| `AUTOTRADE_MAX_TRADES_PER_DAY` | no | `50` | Safety limit on trades per UTC day (windows traded), a guard against bugs. |
| `AUTOTRADE_DAILY_LOSS_LIMIT_USD` | no | `100` | Stops new trades for the rest of the UTC day once realised losses reach this. |
| `AUTOTRADE_SYMBOLS` | no | `btc,eth` | Which coins to trade. |
| `ENTRY_MIN_CENTS` | no | `50` | Lowest live price (in cents) it will buy at. `0` also trades cheaper entries (below 50c). |
| `ENTRY_MAX_CENTS` | no | `60` | Highest live price it will buy at. Above this there is no trade. |
| `AUTOTRADE_EXECUTION` | no | `maker_first` | How orders are sent. `maker_first` rests a maker order, then "fills now" after `MAKER_FILL_TIMEOUT_SECONDS`. `taker` sends one immediate fill-and-kill order at the best ask and nothing ever rests. See section 5a. |
| `TAKER_SLIPPAGE_CENTS` | no | `1` | `taker` only: the price cap of each fill-and-kill order is `min(best ask + this, ENTRY_MAX_CENTS)`. It absorbs a one-cent move between reading the book and the order landing; it can never go above `ENTRY_MAX_CENTS`. |
| `TAKER_MAX_ATTEMPTS` | no | `3` | `taker` only: how many fill-and-kill attempts per window. Only a clean no-fill is retried. |
| `TAKER_RETRY_WINDOW_SECONDS` | no | `20` | `taker` only: retries stop this many seconds after the decision. |
| `MAKER_FILL_TIMEOUT_SECONDS` | no | `45` | `maker_first` only: how long a maker order rests before "fill now" converts the remainder. |
| `ORDER_TTL_SECONDS` | no | `360` | How long an order may rest at most (it never outlives its 15-minute window). |
| `AUTOTRADE_WAIT_SECONDS` | no | `10` | Wait after window open before deciding. |
| `AUTOTRADE_MAX_AGE_SECONDS` | no | `180` | Ignore a TAKE seen later than this after window open. |
| `AUTOTRADE_KILL_SWITCH` | no | off | `1` (or `true`/`yes`/`on`) stops all trading and cancels resting orders. See section 8. |
| `AUTOTRADE_POLL_MS` | no | `3000` | How often it checks for signals. Leave as is. |

The worker refuses to start if a value is invalid, and the message never includes your key.

### 5a. Execution mode: `maker_first` or `taker`

`AUTOTRADE_EXECUTION` decides how the worker buys once a TAKE passes every check. Everything before that
point is identical in both modes: the same signal, the same 10-second wait, the same 3-minute cutoff, the
same price range, the same stake, balance and daily limits. Only the order differs.

| | `maker_first` (default) | `taker` |
|---|---|---|
| What is sent | A resting **maker** order just below the best ask. After `MAKER_FILL_TIMEOUT_SECONDS` (45s), if it has not filled and the price is still in range, it is cancelled and the rest is bought as a **taker** order. | **One** immediate **fill-and-kill** order at the best ask. Whatever matches at once is the trade; the exchange cancels the rest. **Nothing ever rests.** |
| Price rule | Only buys while the price is inside `ENTRY_MIN_CENTS`-`ENTRY_MAX_CENTS`, judged from the signal card's live price. | The real best ask from the live order book must be inside that range (the card's midpoint is not used). Each order's cap is `min(best ask + TAKER_SLIPPAGE_CENTS, ENTRY_MAX_CENTS)`. `ENTRY_MAX_CENTS` (60c by default) is a hard ceiling: an ask above it is skipped (`skipped: price_out_of_band_at_sizing`), never chased. |
| Fill rate | Can miss (see below). | Fills whenever the ask is still there when the order lands. A fill-and-kill that fills **nothing** cannot double-fill, so it is retried, up to `TAKER_MAX_ATTEMPTS` (3) times within `TAKER_RETRY_WINDOW_SECONDS` (20s) of the decision, reading a **fresh book** before each attempt and only while the ask stays in range. It is **never** retried after any fill (partial or full), after an unexpected error, or if it cannot confirm nothing was bought. If every attempt misses, the window is recorded `taker_no_fill` and is not tried again. |
| Fees | Makers pay no Polymarket fee. | Takers pay Polymarket's taker fee (below). |
| Entry price | About one tick (1c) better than the ask. | The ask itself. |

**The trade-off, in plain terms.**

- **Taker costs more per trade.** Polymarket charges takers `fee = shares x 0.07 x price x (1 - price)` on these
  15-minute markets (its published formula; makers are never charged). At 55c that is about 3.2% of the stake,
  roughly **0.03R**, where 1R is the stake on one trade. Paying the ask instead of resting a cent lower adds roughly
  another 0.02R. Together that is about **0.05R more per trade** than a maker fill. These are estimates; the exact
  amounts depend on the price on the day.
- **Taker fills every signal.** A maker order only fills if the market comes down to it. When the market
  moves in the signal's direction, which is what happens to a winning signal, the resting order is left behind and never fills.
  So the signals a maker order misses tend to be the winners, while the losers, where price drifts down to
  the order, are the ones it fills. That skew is the price of the cheaper entry. Taker pays more on every trade
  but does not lose the winners.
- **Which is better depends on the numbers.** If a signal's edge per trade is bigger than the extra
  cost, and misses would otherwise skip good signals, taker wins; if you fill most maker orders anyway, `maker_first`
  is cheaper. The CandleOdds fee (the builder fee) is separate and applies in both modes.

**Checked against the chain (first two real taker fills).** The estimated fee matched the fee actually charged to the cent 
(Polymarket rounds fees down to 5 decimals, and the estimate now does too). The logged `bestAsk` is the price of the token's 
*own* order book, but a buy of one side can also match bids on the opposite side (complementary matching: Down costs 
1 minus the best Up bid), so a fill can be cheaper than `bestAsk`; that is real price improvement, not a calculation error. 
`fillPrice` is the true average price. `allInUsd` in the fill line is `spentUsd` plus the fee. The builder fee for our 
builder code is currently 0 on Polymarket's side, so the 0.5% shown in the app is not charged on-chain.

**What you will see in the logs (Railway → your worker → Deployments → View logs):**

- At start-up: `execution mode: TAKER - one fill-and-kill order at the best ask, never above 60c; ...` or
  `execution mode: MAKER_FIRST - ...`, and `execution` inside the first `starting in LIVE mode {...}` line.
- Every decision line includes `execution`.
- `maker_first`: `ORDER PLACED {execution: "maker_first", ...}`, then `ORDER FILLED {execution, fillPrice, feeUsd}`.
  `feeUsd` is `0` for a maker fill (a converted "fill now" leg shows the taker fee).
- `taker`, at the decision: `TAKER BOOK (decision) {bestAsk, askSize, sizeWithinCap, cap, cardMidpoint, ...}`, the real book the go/no-go was based on.
- `taker`, on **every attempt**: `TAKER ATTEMPT {attempt, of, bestAsk, askSize, sizeWithinCap, cap, slippageCents, maxCents, bookAgeMs}`, the fresh book snapshot the order was sent from
  (`askSize` = shares at the best ask, `sizeWithinCap` = shares at or below the cap). Then either
  `TAKER ORDER FILLED {execution: "taker", attempt, fillPrice, shares, feeUsd, cap, bestAsk, ...}`, or
  `TAKER ATTEMPT NOT FILLED {attempt, detail}` and the next attempt, or `TAKER ATTEMPT SKIPPED {attempt, reason, bestAsk}` (the fresh book no longer allowed a buy, or could not be read; nothing was sent).
- `taker`, if every attempt misses: `TAKER ORDER NOT FILLED (window not retried) {reason, attempts, of, detail, bestAsk, cap}`.
- `feeUsd` on a taker fill is an **estimate** from Polymarket's published formula (`feeSource:
  "polymarket_formula_estimate"`); it does not include the CandleOdds builder fee. `fillPrice` is the average price actually paid.
- The same fields (`execution`, `fillPrice`, `feeUsd`) are reported to CandleOdds with each trade, so the mode is visible on our side too.
- Results (`resolved`) in taker mode are **net of that estimated fee**, so a taker window and a maker window are comparable.

To switch, change `AUTOTRADE_EXECUTION` in Railway → Variables and redeploy. A window that already has an
order is never redone, so switching mid-window cannot double a trade. Try `taker` with the pilot stake first.

---

## 6. Verify with a small stake before trusting it

Do this in order. Nothing here risks more than one stake.

1. **Shadow run.** With `AUTOTRADE_MODE=shadow`, let it run until at least one `decision {...}` line
   appears (TAKE signals come a few times a day, not every window). Check it says `would_place` or
   a sensible `skipped` reason. Nothing is traded.
2. **Go live with the smallest stake.** Set `AUTOTRADE_MODE=live`,
   `AUTOTRADE_LIVE_CONFIRM=yes-place-real-orders`, `AUTOTRADE_STAKE_USD=5`, `AUTOTRADE_MAX_STAKE_USD=5`,
   plus `WALLET_PRIVATE_KEY` and `AUTOTRADE_EXPECTED_WALLET`. (The minimum order is 5 shares, about
   $2.75 at 55 cents, so a $5 stake is the smallest sensible size.) Redeploy.
3. **Check the pre-flight.** The logs must show `preflight ok:` lines for wallet, location, balance and
   approvals. If it prints `STOP: Pre-flight failed`, fix what it says (section 9) and redeploy.
4. **Wait for the first real trade.** When a TAKE fires you will see `ORDER PLACED` with an order id.
   Confirm it independently: your trading wallet's page on Polymarket
   (`https://polymarket.com/profile/<your wallet>`) and the **Positions** screen in CandleOdds show
   the fill once it happens; the logs show `ORDER FILLED` (or `ORDER PARTIAL FILL`). If it is not filled after 45 seconds you will see `FILL NOW` in the logs
   (or the maker keeps resting if the price left the range).
5. **Watch the result.** After the window closes, the logs show `resolved` with win/loss and P&L.
   Only after you are comfortable with a few trades should you consider anything above the pilot limits.

---

## 7. What happens on redeploys, restarts and crashes

- The worker keeps its state in Postgres. After any restart it **never trades a window twice**.
- Resting orders keep resting through a restart; they expire on their own at the end of their window
  (at the latest), so a stopped worker cannot leave an order running.
- If the worker crashed at the exact moment of placing an order, that window is marked
  `live_failed` (uncertain) and is **not** retried. Check your Polymarket profile for that window.
- If your server's clock drifts more than 30 seconds from CandleOdds', it makes no decisions until fixed.

---

## 8. How to pause or stop

Pick the one that fits:

1. **Pause (recommended):** set `AUTOTRADE_KILL_SWITCH=1` and redeploy. The worker stops making
   decisions, **cancels its resting orders**, and reports it. Set it back to `0` (or delete it) and
   redeploy to resume.
2. **Stop completely:** in Railway, remove the deployment or delete the service.
3. **Your token can be revoked.** Making a new token on /auto/setup revokes the old one; CandleOdds can also revoke it,
   and it stops working if your membership no longer includes Auto. The worker notices within seconds, cancels its
   resting orders and stops.
4. **Emergency exit:** withdraw funds from the **Wallet** screen in CandleOdds. To also remove the
   key from Railway, delete the `WALLET_PRIVATE_KEY` variable.

If the worker's location ever becomes blocked by Polymarket it halts by itself (it re-checks hourly).

---

## 9. Troubleshooting

| You see | What it means / what to do |
|---|---|
| `STOP: Configuration problems: ...` | A variable is missing or invalid. The list says which. |
| `CandleOdds rejected CANDLEODDS_TOKEN` | The token is wrong, was replaced or revoked, or your membership no longer includes Auto. Make a new token on /auto/setup (step 2) and put it into `CANDLEODDS_TOKEN`. If /auto/setup says Auto isn't part of your membership, renew it first. |
| `The key controls wallet 0x..., not the AUTOTRADE_EXPECTED_WALLET` | You exported the key from a different account than the wallet address you set. Re-check both on the Wallet screen. |
| `preflight ok: location NL-NH: allowed by the API-level rule ...` | Normal from Amsterdam. Polymarket's website flags the Netherlands as close-only, but its API accepts orders, and the worker follows the API rule. Re-checked hourly (`hourly location check`). |
| `location ...: not allowed for API trading` | The service is in a region where Polymarket refuses new orders. The template deploys to EU West (Amsterdam); for a manual deploy see section 4b.2 (Region). |
| `Balance is $X, less than one stake` | Deposit USDC (Wallet screen) and redeploy. |
| `missing N trading approval(s)` or `Could not set up the trading client` | The wallet has not been set up. Log in to candleodds.com with the same account once, then redeploy. |
| `skipped: insufficient_balance` | Balance dropped below one stake. Deposit more. |
| `skipped: already_traded_window` | The wallet already traded that window (for example by hand in the app). The worker never doubles up. |
| `skipped: price_out_of_band` | The live price was outside your allowed range when it decided. Normal. |
| `skipped: price_out_of_band_at_sizing` | The order-book price (in taker mode the best ask) was outside your allowed range when it sized the order. Normal. |
| `TAKER ORDER NOT FILLED (window not retried)` | Taker mode only: every attempt (up to `TAKER_MAX_ATTEMPTS`) found nothing to match at or below its cap, or the ask left the entry range (`reason: taker_price_moved`), so nothing was bought. Compare `bestAsk`, `askSize` and `cap` in the `TAKER ATTEMPT` lines: a fast market moving more than `TAKER_SLIPPAGE_CENTS` per second is the usual cause. That window is not tried again; nothing is left resting. |
| `ORDER FAILED (window not retried)` | Polymarket rejected the order; the reason is in the log line. That window is not retried. |
| `CLIENT TOKEN REJECTED - stopping` | Your token was revoked mid-run. The worker cancelled its resting orders and paused; it resumes automatically if the token works again. |

---

## 10. Removing the worker completely

1. Set the kill switch (section 8) and let it cancel resting orders, or delete the service.
2. Delete `WALLET_PRIVATE_KEY` from Railway and delete the Postgres database if you no longer need its history.
3. Tell CandleOdds, so your Auto access and token are removed (/admin → Remove Auto).
4. If you want to be certain nobody else can ever use the exported key, move your funds to a new
   CandleOdds account (withdraw, then sign up with another email and deposit there).
