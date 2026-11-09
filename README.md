# Gridbot

Multi-bot grid trading dashboard. One Node process runs the bot engine, a JSON/SSE
API and the Next.js dashboard. Every bot is an independent loop with its own
exchange, symbol, orders, PnL and kill switch. All trading data is stored in MySQL.

## Grid logic

For each bot, levels sit at `entry ± k × spread` for `k = 1..steps`, kept only when
they are strictly inside the lower/upper limits.

- **Sell leg:** sell limit orders rest above the entry. When one fills, a **buy
  target** is placed at `sell price − target spread`.
- **Buy leg:** buy limit orders rest below the entry. When one fills, a **sell
  target** is placed at `buy price + target spread`.
- **Roundtrip:** counted when the target fills. Its PnL is
  `(exit − entry) × qty` (sign by direction); the level is then re-armed.
- **Order style:** resting GTC limit orders, nearest levels to the market first. Only
  **3 buy and 3 sell entry orders** rest at a time (6 per bot); when one fills, the next
  free level on that side is placed. Target orders are extra and not part of the 3 + 3.
- **Volume cap (Market Making Quantity):** every filled entry quantity counts for the
  bot's lifetime (target fills do not reduce it). Orders always refill (3 buy + 3 sell
  stay open); when filled volume leaves less than one step of room, the bot halts and
  cancels all its orders, targets included. Fills that land at the same moment can go
  over the cap by at most the open entries.
- **Price limits:** market price above the upper or below the lower limit → the bot
  stops completely and cancels all its orders.
- **Instance kill switch:** cancels that bot's orders and marks it `KILLED`.
- **Master kill switch:** freezes all loops, stops every bot, then cancels **every**
  open order on every saved live account (including orders not placed by the bots).
- Stopping never closes positions: inventory from filled entries stays open.

## Modes and exchanges

| Mode | What happens |
|---|---|
| Paper | Live public prices; a resting order fills at its limit when the market trades through it. No account needed. |
| Live | Real orders. Implemented for **Hyperliquid perps** and **Deribit perps** (mainnet and testnet each) and **Binance Spot**. |

Paper price feeds: Hyperliquid, Binance, Bybit, Deribit (Solana/Ethereum use Binance
`<SYMBOL>USDT`). Live adapters for other venues can be added in
`src/server/exchanges/` by implementing `ExchangeAdapter`.

Hyperliquid accounts: the public key is your **main wallet address**; the private key
should be an **API wallet** key (Hyperliquid → More → API). Minimum order value is $10.
Start on Hyperliquid Testnet.

Binance accounts: API key + HMAC secret with Spot trading enabled (never withdrawals);
if the key is IP-restricted, allow the server IP. Binance bots are Spot: the account must
hold the coin for sell levels and the quote asset for buy levels (checked before start).
When Binance takes the buy fee in the bought coin, the target sell uses the net quantity.

Deribit accounts: Client ID + Client secret of an API key with Trade read/write. Testnet
keys come from test.deribit.com. Quantities use Deribit units: USD for inverse perps
(BTC-PERPETUAL in multiples of 10, ETH-PERPETUAL in multiples of 1), coins for
`*_USDC` linear perps. PnL for inverse perps converts the USD amount to coins at the
entry price, so it is reported in USD.

## Security

- Exchange secrets are encrypted with AES-256-GCM (`MASTER_KEY` in the server `.env`)
  and never returned to the browser. Back up `MASTER_KEY`; without it saved accounts
  cannot be decrypted.
- The server listens on `127.0.0.1` only and has no login. Open it through an SSH
  login (set with `node scripts/set-login.mjs` on the server).

## Open the dashboard on the server

```powershell
ssh -i C:\Users\Dell\Downloads\grid-bot-key.pem -N -L 3000:127.0.0.1:3000 ubuntu@15.252.130.220
```

Keep that window open and browse to http://localhost:3000.

## Deploy

Commit on `main`, then:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1
```

It pushes to GitHub, then on the server pulls, runs `npm ci`, builds and reloads the
pm2 process. Running bots pause during the restart and resume from MySQL; orders stay
on the exchange. Server settings come from the git-ignored `.env.deploy`.

## Local development

Uses the bundled Node in `.tools` (or any Node ≥ 22). Without `DB_HOST` the server
uses in-memory storage.

```powershell
$env:Path = "$PWD\.tools\node-v24.21.0-win-x64;$env:Path"
npm install
npm test
npm run typecheck
npm run build
npm start          # http://127.0.0.1:3000
```

## Structure

- `server.ts` — process entry: engine, API, Next.js.
- `src/server/engine/grid.ts` — one bot: levels, fills, targets, roundtrips, circuit breakers.
- `src/server/engine/manager.ts` — all bots, accounts, master kill switch, validation.
- `src/server/exchanges/` — paper and Hyperliquid adapters, public price feeds.
- `src/server/store/` — MySQL store (tables created on start) and in-memory store.
- `src/server/api.ts` — `/api/*` routes and the `/api/stream` live feed.
- `src/app/` — dashboard UI.
- `tests/` — engine and exchange tests.

MySQL tables: `accounts`, `bots`, `orders`, `fills`, `roundtrips`, `events`.
