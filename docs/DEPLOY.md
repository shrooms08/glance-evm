# Deploying Glance

One Railway service runs the API and, in the same process, the feed keeper (US East). The console runs on Vercel. The
extension is built against the hosted API and shared as a zip. This page lists every variable by name, with what it is
and where to get it. It never shows a value: paste values straight from their source into the dashboard.

Order: **1. Railway** (you need its URL for the rest) → **2. Vercel** (you need its URL for CORS) → **3. Back to Railway**
for `CORS_ORIGINS` → **4. The extension** → **5. The checklist**.

Before you start:

- **Stop every other keeper.** The Railway API mirrors the feeds from now on, and two keepers on one key fight over
  nonces. The GitHub Actions keeper is manual only now (`.github/workflows/keeper.yml`). Also stop any local
  `pnpm --filter keeper watch` and any local API running with `KEEPER_IN_PROCESS=1`.
- **Rotating the agent key?** Make a new one first (see "Rotating the agent key" below). You will paste it into
  Railway in step 1.

---

## 1. Railway: the API and the keeper

1. **railway.com → New Project → Deploy from GitHub repo →** `shrooms08/glance-evm`. If the repo isn't listed, grant the
   Railway GitHub app access to it (the repo is private).
2. Railway reads **`railway.json`** at the repo root. It builds `apps/api/Dockerfile` (Node 22, only the API and what it
   needs), runs one replica, and checks `/health/live`. Leave **Settings → Build** alone.
3. **Settings → Deploy → Region: US East.** Leave **Replicas: 1**: a volume attaches to one instance, and the keeper
   must run once.
4. **Add a volume:** on the project canvas, right-click the service (or ⌘K → "Volume") → **Attach volume** → mount
   path **`/data`**. Everything the API keeps lives there: the voice cache and pre-recorded lines, the daily counters,
   the LLM budget, sessions, the faucet ledger, chart caches, the refusal log, and the keeper's lock and pause file.
   Missing pre-recorded lines are recorded again at boot.
5. **Variables tab:** add the variables below (**Raw Editor** takes several at once).
6. **Settings → Networking → Generate Domain.** Note the URL (`https://<name>.up.railway.app`): it is `API_URL` below.
7. **Deploy**, then watch **Deploy Logs** for the banner (checklist below).

### Required

| Variable | What it is | Where you get it |
|---|---|---|
| `NODE_ENV` | `production`: redacted `/health`, fake voice refused, CORS warnings | type it |
| `DATA_DIR` | `/data`, the volume's mount path | step 4 |
| `AGENT_PRIVATE_KEY` | the agent key that signs trades for linked vaults (testnet only) | the file `scripts/new-agent-key.sh` wrote (or your current agent key) |
| `RPC_URL` | the testnet RPC the API uses first (a keyed QuickNode URL is fine here: it stays on the server) | QuickNode dashboard → your Robinhood Chain testnet endpoint → HTTP Provider |
| `CORS_ORIGINS` | the browser origins allowed to call the API, comma separated: `chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl` and the console's Vercel URL | the extension ID is fixed; the Vercel URL comes from step 2 (set the extension alone first, add Vercel in step 3) |
| `TRUST_PROXY` | `true`: Railway's proxy passes the client IP, so the per-IP rate limits work | type it |
| `KEEPER_IN_PROCESS` | `1`: this API runs the feed keeper | type it |
| `KEEPER_PRIVATE_KEY` | the key that owns the testnet price feeds. Not the agent key (the API refuses that) | the same key as the GitHub Actions secret `KEEPER_PRIVATE_KEY` (and `apps/keeper/.env`) |

### Recommended (features)

| Variable | What it is | Where you get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude: company lookup, Show me, chart vision, voice intents | console.anthropic.com → API Keys |
| `ASSEMBLYAI_API_KEY` | speech recognition (the default provider) | assemblyai.com dashboard → API Keys |
| `DEEPGRAM_API_KEY` | Glance's voice (Flux Sienna) and the speech-recognition fallback | console.deepgram.com → API Keys |
| `FINNHUB_API_KEY` | live market prices (every 15s while the market is open; Yahoo when unset or failing) and news for "why is it moving" | finnhub.io → Dashboard |
| `ADMIN_TOKEN` | 16+ characters: `/health?admin=<token>` shows the full view in production | generate one yourself (e.g. a password manager) |
| `GIT_COMMIT` | the commit `/health` reports | Railway variable reference: `${{RAILWAY_GIT_COMMIT_SHA}}` |
| `RPC_MAINNET_URL` | Robinhood Chain mainnet, read only (charts and the keeper's source feeds). Default: the public RPC | a QuickNode mainnet endpoint, or leave unset |

### Optional (defaults are fine)

| Variable | What it is |
|---|---|
| `RPC_FALLBACK_URLS` | more testnet RPCs, comma separated (default: the public one) |
| `KEEPER_INTERVAL_MS` | how often the keeper runs (default 30000, minimum 15000) |
| `LIVE_ORACLE_MAX_GAP_BPS` | the drift guard: refuse a trade while the live price and the vault's oracle price are more than this far apart (default 200 = 2%) |
| `KEEPER_PAUSED` | `1` pauses the keeper (a file `keeper.paused` in `/data` does the same without a redeploy) |
| `DEFAULT_VAULT` | the vault used when a request names none |
| `ASSEMBLYAI_STT_SECONDS_PER_DAY`, `VOICE_STT_SECONDS_PER_DAY`, `VOICE_TTS_CHARS_PER_DAY` | daily voice caps (3600 s, 1800 s, 60000 characters) |
| `ASSEMBLYAI_WARM` | `panel` (default) or `key-down`: when an AssemblyAI session opens ahead of time |
| `STT_PROVIDER`, `ASSEMBLYAI_MODEL`, `DEEPGRAM_MODEL`, `DEEPGRAM_TTS_VOICE`, `DEEPGRAM_TTS_FALLBACK_VOICE` | voice providers and models |
| `LLM_DAILY_CALL_LIMIT`, `LLM_BUDGET_RESOLVER`, `LLM_BUDGET_INTENT`, `LLM_BUDGET_WHY`, `LLM_BUDGET_OTHER` | Claude's daily budget, overall and per purpose |
| `CHART_VISION_DAILY_LIMIT`, `CHART_VISION_MODEL`, `INTENT_MODEL`, `WHY_MODEL`, `SHOWME_MODEL`, `RESOLVER_MODEL` | Claude models and the chart-vision cap |
| `RATE_LIMIT_PER_MINUTE`, `TRADE_RATE_LIMIT_PER_MINUTE`, and the other `*_RATE_LIMIT_PER_MINUTE` | per-IP limits |
| `FAUCET_PRIVATE_KEY`, `FAUCET_DAILY_USDG`, `FAUCET_DAILY_ETH` | the in-app testnet faucet (off without the key) |
| `OPEN_DEMO_VAULTS`, `DEMO_TRADES_PER_HOUR` | recording day only: vaults that trade without a linked browser (leave empty) |

**Never set in production:** `PORT` (Railway sets it), `VOICE_PROVIDERS` (`fake` is refused in production),
`VOICE_LIVE_TESTS` (refused), or file paths (`LLM_CACHE_DIR`, `REFUSAL_LOG_FILE`, `SESSION_STORE_FILE`,
`KEEPER_PAUSE_FILE`): `DATA_DIR` sets them all.

---

## 2. Vercel: the console

1. **vercel.com → Add New → Project → Import** `shrooms08/glance-evm` (grant the Vercel GitHub app access if needed).
2. **Root Directory: `apps/console`.** Framework Preset: **Next.js** (detected). Keep **"Include files outside the root
   directory in the Build Step"** on: the console reads `deployments/46630.json` and `packages/*`. Install and build
   commands: the defaults (pnpm, from the root lockfile).
3. **Environment Variables** (Production). All of these end up in the browser, so none may be a secret. The build
   refuses an RPC URL with a key in it, or any public variable named like a secret.

| Variable | What it is | Where you get it |
|---|---|---|
| `NEXT_PUBLIC_GLANCE_API_URL` | the API | your Railway URL (step 1.6) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect for mobile wallets (public by design) | cloud.reown.com → your project → Project ID |
| `NEXT_PUBLIC_EXTENSION_DOWNLOAD_URL` | optional; default `/downloads/glance-extension-latest.zip`, which the console serves itself (`pnpm release:extension` writes it) | leave unset |
| `NEXT_PUBLIC_EXPLORER_URL` | optional; default: the Robinhood Chain testnet explorer | leave unset |
| `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_RPC_FALLBACK_URLS` | optional; **leave unset**: the browser uses the public RPC. Never a keyed URL | — |

4. **Deploy.** Note the production URL (`https://<name>.vercel.app`, or your own domain): it is `CONSOLE_URL` below.
   The chain ID is not a variable: it comes from `deployments/46630.json`.

## 3. Railway again: allow the console

Set `CORS_ORIGINS` to `chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl,<CONSOLE_URL>` (comma, no spaces, no
trailing slash) and redeploy. The banner's `CORS origins:` line should show both, and no warning.

## 4. The extension, pointed at production

To publish the download the console's **Get Glance** page offers (the hosted URLs are the defaults):

```
pnpm release:extension
```

This builds the production extension and copies the zip to `apps/console/public/downloads/glance-extension-<version>.zip`
and `glance-extension-latest.zip`. Commit both: Vercel serves them at `/downloads/…` on the next deploy.

For a build against other URLs:

```
API_URL=<your Railway URL> CONSOLE_URL=<your Vercel URL> pnpm --filter extension build:prod
```

This builds into `apps/extension/.output-prod/` (never your development `.output/`), zips it to
`apps/extension/.output-prod/glance-extension-<version>.zip`, and checks that the extension ID is still
`gmcdcaoneeohbacbnafjdnkkoojgnogl`. The manifest's fixed public key keeps that ID, so `CORS_ORIGINS` stays right.

- The zip is what you share: upload it where `NEXT_PUBLIC_EXTENSION_DOWNLOAD_URL` points. Installing it: unzip it,
  open `chrome://extensions`, turn on Developer mode, and click **Load unpacked** on the folder.
- Already installed from a development build? Its API address stays whatever **Settings → Advanced → API** says
  (localhost). Change it there to the Railway URL, or remove and reinstall the extension.

---

## Rotating the agent key

A vault owner can switch an existing vault to a new agent: `GlanceVault.setAgent(newAgent, expiry)` is owner only. It
replaces the agent in place and keeps every limit, the token and router allowlists and the rolling spend windows.
No new vault is needed.

1. `bash scripts/new-agent-key.sh ~/glance-agent.key` writes the new key to that file (permissions 600) and prints only
   the new address. The file must be outside the repo (or gitignored); the script refuses otherwise.
2. Send the new address a little testnet ETH for gas.
3. Railway → Variables → `AGENT_PRIVATE_KEY` → paste the value from the file → redeploy. `/health` now reports the new
   `agent.address`.
4. In the console, **Limits** shows **"Approve new Glance agent"** on each vault whose agent differs: one wallet
   signature (`setAgent`, 29 days). The old key can't trade from the next block. New vaults set up in the console
   authorise the new agent directly.
5. Delete the key file once it is in Railway (or keep it in a password manager).

---

## 5. Post-deploy checklist

**Banner** (Railway → Deploy Logs), in order:

- `Glance API on http://localhost:<port>`, then `chain 46630 via …` (RPC URLs are redacted)
- `agent key loaded (0x…)`: the agent you expect
- `voice transcription: assemblyai (universal-3-5-pro, …)` and `assemblyai today: <used>/3600 s (resets 00:00 UTC)`
- `voice speech: deepgram flux-sienna-en …`, and later `voice pre-recorded: N common lines in flux-sienna-en`
- `data dir /data`
- `live prices: Finnhub, every 15s while the market is open; trades refused past 200 bps from the oracle`
- `CORS origins: chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl, https://<console>`, with no `warning:` line
- `keeper: in-process every 30s (lock /data/keeper.lock)`, then
  `[keeper] keeper in-process: every 30s as 0x…, 7 feeds on chain 46630`. After that: one `[keeper] … wrote …` line
  per write, during market hours.

**`/health`** (`https://<api>/health`, the public view):

- `ok: true`, `chainId: 46630`, a recent `blockNumber`
- `agent.address`: the agent you expect, `agent.keyLoaded: true`
- `keeper.lastWriteAt`: recent during market hours; `feeds[*].ageSeconds` small while the market is open
- The full view: `https://<api>/health?admin=<ADMIN_TOKEN>` (the agent's balance, voice, budgets,
  `keeper.inProcess: true`)
- `https://<api>/health/live` answers `{"ok":true}` at once (Railway's health check)

**One voice turn:** in the extension, hold ⌥V and say "what's Tesla at?". Railway logs one
`[voice] turn: release | … | assemblyai: … chars` line and one `[voice] assemblyai session closed: … carried speech`
line. You hear the reply.

**One trade:** connect a vault in the console, then buy $1 of a stock from the extension. It confirms, and the trade
shows on the console's **Activity** page with a transaction link.

**Keeper:** the Actions tab shows no new scheduled "Feed keeper" runs (manual only now), and only the Railway logs show
`wrote` lines.
