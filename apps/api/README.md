# Glance API

The backend that the browser extension and the console share. It resolves company names in page text, reads prices and
vault state from Robinhood Chain testnet, quotes trades with an on-chain preflight, and places trades with the agent
key. It turns every contract error into one sentence the assistant can say.

- No database. The stock catalog is a file (`data/catalog.json`), history comes from on-chain events, and every
  address comes from `deployments/46630.json` at the repo root.
- Stack: Node 22+, TypeScript, Hono, viem, zod. Tests use Vitest.

```sh
cp apps/api/.env.example apps/api/.env   # optional: every variable has a default
pnpm install
pnpm --filter api dev                    # http://localhost:8790
pnpm --filter api test                   # unit + live integration (integration skips when offline)
```

Without `AGENT_PRIVATE_KEY` every endpoint works except `POST /trade`, which returns 503.

## The agent key

`src/signer.ts` is the only code that reads `AGENT_PRIVATE_KEY`. The vault bounds the key on chain:

- **What it can do:** buy and sell approved tokens through approved routers, within the per-trade and daily caps, at
  a price no worse than the oracle's minus the slippage limit, until it expires.
- **What it can never do:** withdraw funds, change limits or approvals, or extend its own expiry.

The key is never logged and never returned by any endpoint. Trades run one at a time so they never race on the nonce.

## Errors the assistant can say

Every contract custom error, including desk and token errors that bubble up through the vault, becomes a response
like this:

```json
{
  "code": "PER_TRADE_CAP",
  "error": "ExceedsPerTradeCap",
  "message": "That's over your $100 per trade limit. Want me to buy $100 instead?",
  "args": { "notional": "150000000", "cap": "100000000" },
  "detail": { "requested": "150000000", "limit": "100000000", "over": "50000000", "suggestedAmount": "100000000", "suggestedAmountFormatted": "$100" }
}
```

- **`code` is stable.** The extension and console branch on it.
- **`message` is a sentence the assistant can say.** Each one is pinned by `test/unit/errors.test.ts`.
- **`detail` carries the numbers:** how far over, how much is left, `retryAfterSeconds`, and a suggested amount
  that would pass.
- **Money uses the token's real decimals.** "It frees up in 3 hours" is computed from the vault's own 24-hour window,
  rebuilt from `Bought` and `Sold` events.

| Code | Contract error | Example message |
| --- | --- | --- |
| `PER_TRADE_CAP` | `ExceedsPerTradeCap` | That's over your $25 per trade limit while the market's closed. Want me to buy $25 instead? |
| `DAILY_BUY_CAP` / `DAILY_SELL_CAP` | `ExceedsDailyCap` / `ExceedsDailySellCap` | You've used your daily limit. It frees up in 3 hours. |
| `ORACLE_STALE` | `OracleStale` | The market's closed and the price is 4 days old, so I'm not trading on it. |
| `AGENT_EXPIRED` | `AgentExpired` | My permission to trade for you expired 2 hours ago. Renew it in the console and I can carry on. |
| `PAUSED` | `VaultPaused` | Trading is paused on this vault. Unpause it in the console to let me trade. |
| `TOKEN_NOT_APPROVED` | `TokenNotApproved` | TSLA isn't on this vault's approved list, so I can't trade it. |
| `ROUTER_NOT_APPROVED` | `RouterNotApproved` | This vault hasn't approved the trading desk, so I can't place the order. |
| `SLIPPAGE` | `SlippageTooHigh` | That price is 0.8% outside your slippage limit, so I didn't trade. |
| `BUFFER_FULL` | `SpendBufferFull` | You've made 32 trades in the last 24 hours, the most this vault allows. The next one frees up in 2 hours. |
| `NOT_OWNER` | `NotOwner` | Only the vault owner can do that. I can trade, but I can never move your money out. |
| `INSUFFICIENT_BALANCE` | `InsufficientBalance` | You only have $12.50 in the vault. Add funds or buy less. |
| `DESK_INVENTORY` | `InsufficientInventory` (desk) | The trading desk only has 0.5 TSLA left. Try a smaller buy. |

The remaining codes are `NOT_AGENT`, `NO_PRICE_FEED`, `SHORT_FILL`, `ZERO_AMOUNT`, `SEQUENCER_DOWN`,
`SEQUENCER_GRACE`, `ORACLE_BAD_PRICE`, `DESK_PRICE_STALE`, `DESK_PRICE_MOVED`, `DESK_NOT_LISTED`, `TRANSFER_FAILED`,
`REENTRANCY`, `INVALID_SETTING`, `FAUCET_LIMIT` and `UNKNOWN`. A test fails if any error in the ABIs maps to `UNKNOWN`.

Every error response has the shape `{ "error": { "code", "message", "guard"? } }`. `guard` is present when a
contract guard caused the error.

## Endpoints

Amounts appear as `{ raw, value, formatted }`: `raw` is in the token's smallest unit, `value` is a plain decimal
string, and `formatted` is for display.

### `GET /health`

```sh
curl localhost:8790/health
```
```json
{ "ok": true, "chainId": 46630, "expectedChainId": 46630, "blockNumber": "123187043",
  "agent": { "address": "0xa7078432F7Aa4db99F88cB181049872d1ea697a9", "keyLoaded": false, "matchesDemoVault": true,
             "ethBalance": "0.00199743196", "ethBalanceWei": "1997431960000000" },
  "llmFallback": false,
  "demoVaults": { "testUSDG": "0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D", "paxosUSDG": "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113" } }
```

### `GET /catalog`

This lists the five stocks. Each entry has its aliases, token and feed addresses, and flags for whether the token and
the feed are real or stand-ins.

```json
{ "chainId": 46630, "usdg": { "address": "0x2315…375E", "real": false, "source": "TestUSDG (public faucet)" },
  "stocks": [ { "symbol": "TSLA", "name": "Tesla", "legalName": "Tesla, Inc.",
                "aliases": ["Tesla", "Tesla Inc", "Tesla, Inc.", "Tesla Motors", "$TSLA", "TSLA"],
                "token": "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E", "tokenDecimals": 18, "tokenReal": true,
                "feed": "0xb856AB851b58B3d0436d62b465A9e92c481E9e9f", "feedReal": false,
                "priceSourceKind": "chainlink-live", "priceSource": "chainlink-live: Robinhood mainnet feed 0x4A11…, updated 2026-09-23T08:13Z" } ] }
```

### `POST /resolve`

This finds catalog companies in text. Offsets are JavaScript string indices (UTF-16), so the extension can
underline matches with `Range`. The rules:

- Company names match without regard to case, but only as whole words: "Tesla's" matches, "Teslas" does not.
- Bare tickers must be capitals (`TSLA`); cashtags (`$tsla`) match in any case.
- Known collisions are excluded, such as "Nikola Tesla", "Amazon rainforest" and AMD in eye-disease text.
- If `ANTHROPIC_API_KEY` is set and the dictionary finds nothing, Claude is asked. Its answer only counts if the quote
  appears word for word in the text.

```sh
curl -X POST localhost:8790/resolve -H 'content-type: application/json' \
  -d '{"text":"Tesla and $PLTR rallied while Amazon rainforest fires spread; AMD fell."}'
```
```json
{ "source": "dictionary", "count": 3, "matches": [
  { "symbol": "TSLA", "text": "Tesla", "start": 0, "end": 5, "alias": "Tesla", "kind": "name", "source": "dictionary", "stock": { "…": "catalog entry" } },
  { "symbol": "PLTR", "text": "$PLTR", "start": 10, "end": 15, "kind": "cashtag", "…": "…" },
  { "symbol": "AMD", "text": "AMD", "start": 62, "end": 65, "kind": "ticker", "…": "…" } ] }
```

### `GET /price/:symbol[?vault=0x…]`

This returns the oracle price and its age. The market state is classified with the freshness settings that vault
holds for the token. The vault defaults to the TestUSDG demo vault.

```json
{ "symbol": "TSLA", "price": { "raw": "38025740000", "decimals": 8, "value": "380.2574" },
  "updatedAt": 1790163092, "ageSeconds": 2695, "age": "45 minutes", "marketState": "OPEN",
  "freshness": { "vault": "0xacfE…EE2D", "openMaxAge": 3600, "closedMaxAge": 288000 },
  "feedReal": false, "priceSourceKind": "chainlink-live", "priceSource": "chainlink-live: …" }
```

### `GET /vault/:address`

This returns the vault's owner, agent, limits and state:

- the agent and its expiry, and the per-trade and daily limits;
- the effective caps per market state;
- each rolling window: how much is used, when the next amount frees up, and when the window clears;
- balances, and positions valued at the oracle price.

Each window also has `reconstructed: true` when the history rebuilt from events matches the contract exactly.

```json
{ "owner": "0xca6A…aDFF", "agent": "0xa707…97a9", "agentActive": true, "agentExpiresInSeconds": 2502000, "paused": false,
  "limits": { "perTrade": { "formatted": "$100" }, "dailyBuy": { "formatted": "$500" }, "dailySell": { "formatted": "$500" },
              "maxSlippage": "1%", "weekendCap": "25%" },
  "effectiveCaps": { "OPEN": { "perTrade": { "formatted": "$100" } }, "CLOSED": { "perTrade": { "formatted": "$25" } } },
  "buyWindow": { "used": { "formatted": "$25" }, "remaining": { "formatted": "$475" }, "nextReleaseInSeconds": 84626,
                 "clearsInSeconds": 84626, "tradesInWindow": 1, "reconstructed": true },
  "sellWindow": { "used": { "formatted": "$0" }, "reconstructed": true },
  "balances": { "usdg": { "formatted": "$975" }, "invested": { "formatted": "$24.92" }, "total": { "formatted": "$999.92" } },
  "positions": [ { "symbol": "TSLA", "quantity": { "formatted": "0.0655 TSLA" }, "value": { "formatted": "$24.92" },
                   "marketState": "OPEN", "effectiveCaps": { "…": "…" } } ] }
```

### `GET /vault/:address/activity[?limit=50]`

This returns trades and owner actions decoded from the vault's events, newest first. Each item has its transaction
hash and an explorer link.

```json
{ "items": [
  { "type": "Bought", "kind": "trade", "summary": "Bought 0.0655 TSLA for $25", "symbol": "TSLA",
    "txHash": "0x90ce4b85a6…", "timestamp": 1790164046, "explorerUrl": "https://explorer.testnet.chain.robinhood.com/tx/0x90ce…",
    "data": { "usdgIn": "25000000", "tokensOut": "65542…", "marketState": "OPEN", "…": "…" } },
  { "type": "Deposited", "kind": "owner", "summary": "Deposited $1,000", "…": "…" } ] }
```

### `GET /quote?vault=&symbol=&side=buy|sell&amount=[&slippageBps=]`

For a buy, `amount` is in USDG; for a sell, it is in shares.

The response has three parts:

- **The desk's quote.**
- **The oracle-implied amount,** before the spread.
- **A preflight.** It simulates the exact `buy` or `sell` call with `eth_call`, as the agent, against the live chain.
  It reports whether the trade would pass every guard right now, and if not, which guard stops it and by how much.

`slippageBps` sets how far below the desk quote the minimum output may sit (0 by default, since the desk is
deterministic).

```sh
curl 'localhost:8790/quote?vault=0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D&symbol=TSLA&side=buy&amount=150'
```
```json
{ "symbol": "TSLA", "side": "buy", "amountIn": { "formatted": "$150" },
  "deskQuote": { "formatted": "0.3921 TSLA" }, "oracleImplied": { "formatted": "0.3944 TSLA" }, "spread": "0.3%",
  "marketState": "OPEN",
  "preflight": { "ok": false, "simulatedAs": "0xa707…97a9",
                 "guard": { "code": "PER_TRADE_CAP", "message": "That's over your $100 per trade limit. Want me to buy $100 instead?", "…": "…" } } }
```

### `POST /trade`

The body is `{ vault, symbol, side, amount, slippageBps? }`. The server runs the preflight first. If a guard would
stop the trade, it answers 422 with the guard and sends nothing. Otherwise it signs with the agent key, sends the
transaction, waits for the receipt, and returns the fill and the resulting balances.

```sh
curl -X POST localhost:8790/trade -H 'content-type: application/json' \
  -d '{"vault":"0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D","symbol":"TSLA","side":"buy","amount":"20"}'
```
```json
{ "txHash": "0x32f2…", "explorerUrl": "https://explorer.testnet.chain.robinhood.com/tx/0x32f2…", "side": "buy",
  "filled": { "usdgIn": { "formatted": "$20" }, "tokensOut": { "formatted": "0.0524 TSLA" } },
  "balancesAfter": { "usdg": { "formatted": "$955" }, "TSLA": { "formatted": "0.1179 TSLA" } } }
```

## Safety

- **Validation:** every input is checked with zod; addresses, tickers and decimal strings are strict. `/resolve`
  text is capped at 20,000 characters.
- **CORS:** allows only the origins in `CORS_ORIGINS` (for example `chrome-extension://<id>`), plus
  `http://localhost:*` outside production.
- **Rate limits:** per IP, 120 requests a minute overall and 10 a minute on `/trade`. Both are configurable.
  `X-Forwarded-For` is trusted only with `TRUST_PROXY=true`.
- **Logging:** method, path, status and time only. Request bodies and keys are never logged.

## Tests

```sh
pnpm --filter api test:unit          # resolver near-misses, every error message, money/decimal maths, window maths
pnpm --filter api test:integration   # live testnet: health, catalog, price, vault, activity, quotes; skips when offline
```

The integration tests remove `AGENT_PRIVATE_KEY` and use `eth_call` only, so they never send a transaction.

## Regenerating ABIs

`src/abi.generated.ts` is generated from Foundry's build output. After changing a contract:

```sh
forge build && pnpm --filter api abi
```
