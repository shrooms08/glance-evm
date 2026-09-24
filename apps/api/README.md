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
- **`message` is a sentence the assistant can say.** Each one is pinned by `test/unit/errors.test.ts`, and the console shows the same sentences.
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

### When the testnet isn't responding

A timed-out, rate-limited or unreachable RPC is never reported as an answer about a vault. It returns **503
`RPC_UNAVAILABLE`**: "The Robinhood Chain testnet isn't responding right now. Trying again…". `NOT_A_VAULT` (404) is
said only when the chain actually answered and the address holds no Glance vault, and a quote never turns RPC trouble
into a guard. `src/rpc.ts` tells the two apart by walking viem's error chain.

Each call tries `RPC_URL`, then each of `RPC_FALLBACK_URLS` in order (viem's `fallback` transport, 8s timeout per
endpoint). Put a dedicated endpoint such as QuickNode in `RPC_URL` and keep the public RPC as the fallback, which is
the default. Endpoint paths and tokens are redacted in the startup log.

A trade is never retried. If the RPC fails while sending, the message says the outcome is unknown and to check the
activity first. If it was sent but can't be confirmed, the message includes the transaction hash.

## Claude budget

Claude is optional. The API makes two kinds of call to it: the `/resolve` fallback when the dictionary finds nothing,
and the voice intent. Both go through `src/llmBudget.ts`:

- **Haiku everywhere.** `RESOLVER_MODEL` (formerly `ANTHROPIC_MODEL`, which still works) and `INTENT_MODEL` both
  default to `claude-haiku-4-5`. A model name containing "opus" is refused at startup with one warning line, and Haiku
  is used instead, unless `ALLOW_OPUS=1`. Answers are capped at 256 output tokens, and calls are never retried.
- **Cached.** `/resolve` answers are cached for 24 hours by normalized text (lowercased, whitespace collapsed),
  including "no listed company" answers. The cache is kept in memory and in `RESOLVER_CACHE_FILE` (default
  `apps/api/.cache/resolver.json`, gitignored), so a restart doesn't pay again. Keys are SHA-256 hashes, so no page
  text is written to disk.
- **Capped.** `LLM_DAILY_CALL_LIMIT` (default 150) counts every Claude call across the API, resets at 00:00 UTC, and
  persists next to the cache (`llm-usage.json`). At the limit, the dictionary resolver and the rules intent parser
  answer, and one line is logged: `LLM daily limit reached, using rules`. The user never sees an error.
- **Paused on budget errors.** An Anthropic 401, 402, 429, or a "credit balance" error pauses Claude for an hour, with
  the same fallback.
- **Visible.** The startup banner shows the models, and the calls used today out of the limit. Each call logs one
  line: purpose, model, input and output tokens. The key, prompts, page text and audio are never logged. `/health`
  has `llm: { models, dailyLimit, usedToday, paused }`.

## Endpoints

Amounts appear as `{ raw, value, formatted }`: `raw` is in the token's smallest unit, `value` is a plain decimal
string, and `formatted` is for display.

### `GET /health`

In production (`NODE_ENV=production`) this is the public view: `ok`, the chain, the block, `versions` and the feeds'
ages. The full view below needs `?admin=<ADMIN_TOKEN>`; development always shows it.

```sh
curl localhost:8790/health
```
```json
{ "ok": true, "chainId": 46630, "expectedChainId": 46630, "blockNumber": "123187043",
  "agent": { "address": "0xa7078432F7Aa4db99F88cB181049872d1ea697a9", "keyLoaded": false, "matchesDemoVault": true,
             "ethBalance": "0.00199743196", "ethBalanceWei": "1997431960000000" },
  "llmFallback": false,
  "keeper": { "pausedLocally": false, "lastWriteAt": 1790167636 },
  "feeds": [ { "symbol": "TSLA", "price": { "value": "378.2226" }, "updatedAt": 1790163296, "age": "1 hour",
               "marketState": "CLOSED", "source": "mainnet-mirror", "mainnetFeed": "0x4A11…7C38",
               "lastWrite": { "at": 1790167636, "agoSeconds": 12, "txHash": "0x9045…" } },
             { "symbol": "NFLX", "source": "public-quote", "sourceDetail": "Yahoo Finance NFLX regularMarketPrice (…)", "…": "…" } ],
  "demoVaults": { "testUSDG": "0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D", "paxosUSDG": "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113",
                  "primary": "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113", "defaultVault": "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113",
                  "faucets": { "paxosUSDG": "https://faucet.paxos.com/", "testUSDG": "TestUSDG.faucet(amount) on 0x2315…375E (1,000 per address per UTC day)" } } }
```

`demoVaults.primary` is the headline vault, on real Paxos USDG (marked `primaryVault` in the deployment record);
the TestUSDG vault stays as a fallback. `feeds` gives each stand-in feed's price, age, and the market state the
default vault would apply to it. `source` is
`mainnet-mirror` (kept current by the keeper) or `public-quote` (NFLX). `lastWrite` is the most recent on-chain
`PriceSet`, whether written by the keeper or the deploy script.

### `GET /catalog`

This lists the five stocks. Each entry has its aliases, token and feed addresses, and flags for whether the token and
the feed are real or stand-ins.

```json
{ "chainId": 46630, "usdg": { "address": "0x2315…375E", "real": false, "source": "TestUSDG (public faucet)" },
  "stocks": [ { "symbol": "TSLA", "name": "Tesla", "legalName": "Tesla, Inc.",
                "aliases": ["Tesla", "Tesla Inc", "Tesla, Inc.", "Tesla Motors", "$TSLA", "TSLA"],
                "token": "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E", "tokenDecimals": 18, "tokenReal": true,
                "feed": "0xb856AB851b58B3d0436d62b465A9e92c481E9e9f", "feedReal": false,
                "priceSourceKind": "mainnet-mirror", "priceSource": "RHTSLA / USD", "mainnetFeed": "0x4A1166a659A55625345e9515b32adECea5547C38",
                "seededAtDeploy": "chainlink-live: Robinhood mainnet feed 0x4A11…, updated 2026-09-23T08:13Z" } ] }
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
holds for the token. The vault defaults to `DEFAULT_VAULT`, or else the deployment's primary vault (the Paxos USDG demo
vault).

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

This returns trades and owner actions decoded from the vault's events, and the trades the guards refused, newest
first. Event items have their transaction hash and an explorer link. The console's activity page reads this.

A vault emits no event for a trade it refuses, so refusals (`"kind": "refusal"`) come from two places, and each one
says which in `refusal.source`:

- **`preflight`**: every `/quote` and `/trade` simulates the exact call as the agent against the live vault. When a
  guard would stop it, nothing is sent, and the refusal is recorded with the guard's sentence. It's stored in
  `REFUSAL_LOG_FILE` (default `data/refusals.jsonl`, gitignored), and the same attempt refused for the same reason
  within 10 minutes counts once. There's no transaction, so `txHash` is null.
- **`onchain`**: transactions that reached the vault and reverted, whoever sent them. They're read from the explorer
  (Blockscout) and decoded with the vault's errors, and they have a transaction link.

`sources` says whether each part is complete: `onChainRefusals` is `"unavailable"` when the explorer can't be read.

```json
{ "items": [
  { "type": "Bought", "kind": "trade", "summary": "Bought 0.0655 TSLA for $25", "symbol": "TSLA",
    "txHash": "0x90ce4b85a6…", "timestamp": 1790164046, "explorerUrl": "https://explorer.testnet.chain.robinhood.com/tx/0x90ce…",
    "data": { "usdgIn": "25000000", "tokensOut": "65542…", "marketState": "OPEN", "…": "…" } },
  { "type": "Deposited", "kind": "owner", "summary": "Deposited $1,000", "…": "…" },
  { "type": "Refused", "kind": "refusal", "summary": "Buy $150 of TSLA", "txHash": null, "timestamp": 1790201991,
    "refusal": { "code": "PER_TRADE_CAP", "error": "ExceedsPerTradeCap", "source": "preflight", "via": "quote", "sent": false,
                 "message": "That's over your $100 per trade limit. Want me to buy $100 instead?" } } ],
  "sources": { "events": "ok", "preflightRefusals": { "persisted": true }, "onChainRefusals": "ok" } }
```

### `GET /portfolio/:vault`

This returns what the vault holds and how it's doing: USDG cash, and each stock with its quantity, average cost,
cost basis, oracle price and its age, value, and unrealized and realized PnL. It also has totals and one plain
sentence ("You hold $62 across 2 stocks, up $1.40 overall.").

- **Cost basis:** comes from the vault's own `Bought`, `Sold` and `Withdrawn` events, by the average-cost method, in
  bigint (6-decimal USDG, 18-decimal stocks).
- **Sells:** take out cost at the average and book the difference as realized PnL.
- **Shares that arrived outside a trade:** count at zero cost, flagged `transferredIn`.
- **Event reads:** cached per vault and read incrementally, from the vault's deploy block (found by binary search on
  its code) the first time, then only new blocks.
- **Errors:** the same 503 `RPC_UNAVAILABLE` and 404 `NOT_A_VAULT` as `/vault`.
- **Rate limit:** `PORTFOLIO_RATE_LIMIT_PER_MINUTE` per IP (default 60).

### `GET /why/:symbol`

This says why a stock moved, from the news, and never gives advice.

- **Response:** `{ symbol, move: { pct, from, to, window, source, label, note? }, summary, sources: [{ title, url, site,
  publishedAt }], generatedAt, cached }`.
- **News:** Finnhub company news for the last 3 days (`FINNHUB_API_KEY`, server-side only), cached for 15 minutes.
  Stock Tokens map to their US tickers in `@glance/core/tickers`.
- **Move:** from our own feed history (the stand-in feeds' `PriceSet` events). Otherwise Finnhub's quote, labelled
  "Finnhub quote (change since the previous close)". When the market is closed, the note says the move is as of the
  last close.
- **Summary:** Claude (Haiku, through the LLM budget) writes at most 2 sentences using only the numbered headlines,
  citing them as [1] and [2], in hedged wording, or "No clear news explains this move." It's cached for 3 hours per
  symbol.
- **Checks on the summary:** citations must point at real headlines, and any advice or prediction phrase (the tone
  rules in `@glance/core/tone`) discards the summary and returns the headlines alone.
- **Fallbacks:** at the daily limit or if Claude fails, the top 3 headlines with no summary. If Finnhub is down,
  "News isn't available right now." Neither is ever an error.
- **Rate limit:** `WHY_RATE_LIMIT_PER_MINUTE` per IP (default 20).

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

Signed by a linked browser session (headers `x-glance-session`, `x-glance-signature`, `x-glance-deadline`,
`x-glance-nonce`), or for an open demo vault. Otherwise 401 `SESSION_REQUIRED`, `SESSION_EXPIRED`, `BAD_SIGNATURE` or
`REPLAYED`, each with a sentence the extension shows. See [docs/SECURITY.md](../../docs/SECURITY.md).

### `POST /session/link`, `POST /session/revoke`, `GET /session/status`, `GET /session/list`

The vault owner's EIP-712 signature links or unlinks a browser (the signer must be `vault.owner()` on chain). Status
and list are what the extension and the console's "Linked browsers" card read. `make link-demo-session SESSION=0x…`
links a browser to the demo vault with the deployer key, for recording day.

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

## Voice

Push-to-talk is transcribed, understood and answered here, so it works in any Chromium browser, including Brave and
Arc, which have no browser speech recognition. The extension records in its own offscreen document (never in a web
page) and never holds a key.

| Endpoint | In | Out | Provider |
| --- | --- | --- | --- |
| `WS /voice/stream[?vault=0x…]` | raw 16kHz 16-bit mono PCM in 40ms slices while Option+V is held; `{"type":"stop"}` on release | `{"type":"transcript","text","confidence","ms","timing"}` | Deepgram live, `nova-3`, keyterms = our companies and tickers; `Finalize` on release |
| `POST /voice/transcribe` | a whole recording (fallback when the stream can't open) | `{ text, confidence, provider, ms }` | Deepgram pre-recorded |
| `POST /voice/command` | `{ transcript, context?, vault? }` | `{ intent, symbol, amount, reply, source, note?, ms }` | Claude (`INTENT_MODEL`), else the rules parser; always validated |
| `POST /voice/speak` / `GET /voice/speak?text=` | text | `audio/mpeg` (the GET streams, so playback starts early) | Deepgram Aura (`DEEPGRAM_TTS_VOICE`) or Fish (`VOICE_TTS=fish`); the other catches 401/402/429 |
| `POST /voice/warm` | | `{ ok }` | opens the Deepgram connection and the speech provider's HTTPS connection ahead of a command |
| `GET /voice/status` | | which providers are active (never keys) | |

- **Intents:** `buy`, `sell`, `price`, `spend-so-far`, `explain`, `unknown`. The symbol must be in our catalog and the
  amount must be one the user actually said, whoever produced it; a negation ("don't buy"), an advice question ("should
  I buy?"), a past event ("Tesla bought Twitter"), a hypothetical or anything for later never becomes a buy or sell.
  Ambiguous amounts ("twelve fifty") are not guessed: the card asks. See `src/voice/intent.ts`.
- **Never trades:** a `buy` only tells the extension which card to open. The trade still needs the on-chain preflight,
  the confirm tap, and every vault guard, exactly as when typed. There is no voice path to `POST /trade`.
- **Replies state facts from the chain,** composed by our code (prices and spending are prefetched while the key is
  held, and may be up to 15s old in speech; quotes and trades always read fresh). Claude's sentence is used only for
  `explain` and `unknown`, from the context it was given.
- **Speech cache:** identical short phrases (up to 64, 200 characters each) are served from memory.
- **Latency, measured from Lagos** (round trip to Deepgram ~140-300ms): release to transcript 260-500ms on the warm
  connection (1.8s on a cold first command, when the connection opened while the user was speaking); speech first byte
  ~370-460ms on a kept-alive connection; release to the voice playing ~1.0s (a cached phrase ~0.5s). How:
  - one Deepgram streaming connection is kept warm (KeepAlive every 4s, closed after `VOICE_WARM_IDLE_MS` unused) and
    reused command after command; the extension warms it when the panel opens and on key down;
  - on release the server sends `Finalize` and answers as soon as final results cover all the audio sent (no waiting
    for silence); a connection that opened late gets up to 1.5s to process its backlog first, so no word is cut;
  - provider HTTPS connections are kept alive and re-warmed on each key press (Deepgram's edge drops idle ones ~5s);
  - replies stream: the extension plays the MP3 through MediaSource as it arrives.
  - The server logs each request's breakdown: `[voice] transcription: connect …, release to final …` and
    `[voice] speech …: first byte …, complete …` (timings only, never the words).
- **Fallback:** with no provider configured (or the API unreachable), the extension uses the browser's own speech APIs
  and says so in the panel. The startup log shows which provider is active; placeholder keys are reported and ignored.

```sh
pnpm --filter api test:integration     # real Deepgram and Fish calls with latency, skipped without real keys
VOICE_PROVIDERS=fake PORT=8797 pnpm --filter api dev   # simulated providers, to test the extension's voice path
```

## Safety

- **Validation:** every input is checked with zod; addresses, tickers and decimal strings are strict. `/resolve`
  text is capped at 20,000 characters.
- **Signed trades:** `POST /trade` needs a request signed by a browser session the vault's owner linked (EIP-712), or
  one of the open demo vaults (`OPEN_DEMO_VAULTS`, 10 trades an hour per visitor). See
  [docs/SECURITY.md](../../docs/SECURITY.md).
- **CORS:** allows only the origins in `CORS_ORIGINS`: by default the extension's fixed ID and the console at
  `http://localhost:3000`. **CORS isn't authentication.** Anything outside a browser ignores it, which is why trades
  are signed and the paid endpoints are limited and capped.
- **Rate limits:** per IP, 120 requests a minute overall and 10 a minute on `/trade`, plus a limit for each paid group
  (resolve, why, Show me, chart, portfolio, voice, session). When a request names a browser session, the same limit
  also applies per session. All are configurable. `X-Forwarded-For` is trusted only with `TRUST_PROXY=true`.
- **Daily voice caps:** 1,800 seconds of speech-to-text and 60,000 characters of speech a day. Past them: "Voice is
  resting for today. You can still type." Pre-recorded lines don't count.
- **Size:** JSON bodies are at most 64 KB and audio at most 30 seconds; larger is 413.
- **`/health`:** in production, only ok, chain, block, versions and feed ages, unless `?admin=<ADMIN_TOKEN>`.
- **Logging:** method, path, status and time only. Request bodies and keys are never logged.

## Tests

```sh
pnpm --filter api test:unit          # resolver near-misses, every error message, money/decimal maths, window maths
pnpm --filter api test:integration   # live testnet: health, catalog, price, vault, activity, quotes; skips when offline
```

The integration tests remove `AGENT_PRIVATE_KEY` and use `eth_call` only, so they never send a transaction.

## Regenerating ABIs

The ABIs, the guard sentences (`explainRevert`), money formatting, the window maths and the RPC classifier live in
`packages/core` (`@glance/core`), shared with the console; `src/errors.ts` and its neighbours re-export them.
`packages/core/src/abi.generated.ts` is generated from Foundry's build output. After changing a contract:

```sh
forge build && pnpm --filter api abi
```

## Checking both demo vaults

`pnpm --filter api check-vaults` (or `make check-vaults` from the repository root) quotes a $10 TSLA buy on the Paxos
USDG vault and the TestUSDG vault and simulates each through every vault guard. It is read-only: it never loads the
agent key and sends nothing. It exits 1, with the vault's own reason, if either could not trade right now.
