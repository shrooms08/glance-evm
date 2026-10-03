# Glance EVM: security audit

Read-only audit of commit `181a522` (main, extension 0.1.9), 3 October 2026, against the Robinhood Chain testnet
deployment (chain 46630). No source file was changed, no transaction was sent, no `.env` file or secret was read, and
nothing was committed or pushed. The API and the extension/console reviews were done by Sonnet sub-agents and their
key references spot-checked by hand; the contracts, tools, on-chain reads and secret scan were done directly.

## 1. Summary

The vault contracts are in good shape. The code is small and does one thing well. 180 of 180 Foundry tests pass,
including fuzz, invariant and fork suites, and line coverage is 100% on every production contract. The deployed
factory matches this repo byte for byte. Slither's two "High" findings are false positives: they flag the deliberate
balance-delta pattern, which sits behind `nonReentrant`.

Every guarantee in the brief holds in code:
- The agent can never withdraw, nor send funds to anyone but the vault.
- Buy caps are counted in the USDG actually spent.
- Pause, the token and router allowlist, and agent expiry gate every trade.
- Approvals are reset to zero after each swap.

The one Critical finding, **C-1**, is not a code bug. It comes from how the testnet is deployed. The key that writes
the testnet price feeds (and owns the desk) runs on the same Railway host as the agent key. The vault's sell caps are
measured with that price, so one compromise of that server can sell every stock token in a vault for next to nothing.
The vault's own threat model says that server must be assumed compromised. This is acknowledged and is not being fixed
now. Testnet USDG and the stand-in stocks have no real value, and mainnet uses Chainlink feeds that no Glance key can
write.

The API and extension have no Critical or High issues. There are seven Medium findings, all defence in depth:
- API: a nonce replay window after a restart, a spoofable client IP for rate limits, uncapped voice WebSockets, and
  faucet farming.
- Extension: background signing for any content script, a `/link` page that trusts the session in its URL, and
  web-accessible resources that let any site detect Glance.

Model usage is Haiku, plus Sonnet for chart vision; Opus is refused unless `ALLOW_OPUS=1` is set. `pnpm audit` shows
one High, a transitive `ws` in the console that browsers never run. The full-history secret scan found no live
secret in the tree; one hex test fixture from history should be confirmed as fake.

**Verdict: sound for a testnet demo.** The contract layer is fit for purpose. Before any mainnet or real-value
deployment, the C-1 configuration must change (keeper key off the API host, or real Chainlink feeds) and the Medium
findings should be closed.

## 2. Tool results

### Tests

`forge test -vv`: **180 passed, 0 failed, 0 skipped**, in 12 suites. These include `GlanceVault.t.sol` (82),
`GlanceVaultFactoryV2.t.sol`, `SellFlow.t.sol`, `MarketStatusLib.t.sol` and `RollingSpendLib.t.sol`; the invariant
suite `test/invariant/GlanceVault.invariant.t.sol` (128 runs × depth 64); and the fork suites (`test/fork/*`, which
read live testnet state).

### Coverage

`forge coverage --report summary`, fork suites excluded. Production contracts first; the `Total` line in forge's
output also counts scripts and test helpers, so it is not shown.

| Contract | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| GlanceVault.sol | 100.00% (165/165) | 98.59% (210/213) | 91.43% (32/35) | 100.00% (30/30) |
| ConfiguredGlanceVault.sol | 100.00% (17/17) | 96.43% (27/28) | 83.33% (5/6) | 100.00% (1/1) |
| GlanceVaultFactoryV2.sol | 100.00% (25/25) | 100.00% (31/31) | 100.00% (4/4) | 100.00% (5/5) |
| GlanceVaultFactory.sol (V1) | 100.00% (9/9) | 100.00% (9/9) | 100.00% (2/2) | 100.00% (2/2) |
| MarketStatusLib.sol | 100.00% (23/23) | 100.00% (33/33) | 100.00% (6/6) | 100.00% (4/4) |
| RollingSpendLib.sol | 100.00% (32/32) | 100.00% (37/37) | 100.00% (5/5) | 100.00% (3/3) |
| testnet/StockDesk.sol | 100.00% (62/62) | 92.68% (76/82) | 50.00% (6/12) | 100.00% (14/14) |
| testnet/TestPriceFeed.sol | 74.07% (20/27) | 76.19% (16/21) | 50.00% (1/2) | 70.00% (7/10) |
| testnet/TestStockToken.sol | 100.00% (6/6) | 100.00% (3/3) | n/a (0/0) | 100.00% (3/3) |
| testnet/TestUSDG.sol | 100.00% (15/15) | 93.75% (15/16) | 50.00% (1/2) | 100.00% (4/4) |

### Slither

Slither 0.11.6 on `src/` (lib/, test/ and script/ filtered out): 17 results.

| Detector | Impact | Count | Where | Triage |
|---|---|---|---|---|
| reentrancy-balance | High | 2 | `GlanceVault.buy` (441-476), `sell` (486-532) | **False positive.** The balance-before/after around the router call is the intended output measurement (`:466-472`, `:512-519`). Both functions are `nonReentrant`, and the spend is recorded before the call (`:462`, `:510`). `test_maliciousRouter_cannotReenter` (GlanceVault.t.sol:247) proves it. |
| unused-return | Medium | 2 | `IStockRouter.swap*` return ignored (`GlanceVault.sol:468`, `:514`) | **False positive, by design.** The router's reported output is deliberately not trusted; the balance delta is (`:471`). |
| unused-return | Medium | 2 | `latestRoundData` fields ignored (`MarketStatusLib.sol:64`, `GlanceVault.sol:632`) | **False positive.** `roundId` and `answeredInRound` are deprecated in Chainlink's guidance. Price, `updatedAt` and the sequencer's `startedAt` are all checked. |
| timestamp | Low | 10 | expiry, freshness, sequencer grace, rolling window | **Accepted.** Time windows are the point of this code (hour-scale), and the repo's `foundry.toml` lint config excludes this rule for the same reason. |
| too-many-digits | Info | 1 | none | **False positive** (a literal constant). |

**Result: no real finding from Slither.**

### Bytecode match

`forge inspect GlanceVaultFactoryV2 deployedBytecode` against `eth_getCode(0xA76C3E2fe629889D8Bc83b285394eC62673B02E4)`
gives **an exact match: 18,243 bytes each, identical even with the metadata hashes included.** That covers both CBOR
blobs: the factory's own, and the embedded `ConfiguredGlanceVault` creation code. The deployed factory is this source,
and so is every vault it creates.

### pnpm audit (high and critical)

`pnpm audit --audit-level high` over the workspace: **1 high, 0 critical** (plus 4 moderate, not listed).

| Package | Severity | Module | Advisory | Path | Note |
|---|---|---|---|---|---|
| console | High | `ws` <8.21.0 | GHSA-96hv-2xvq-fx4p (memory-exhaustion DoS) | wagmi → @wagmi/connectors → @walletconnect/ethereum-provider → @reown/appkit → … → viem → ws | Transitive, and a Node WebSocket server or client library that never runs in the console's browser bundle. Fix with a `pnpm.overrides` `ws >=8.21.0`. |
| api, extension, keeper, core, design | none | none | none high or critical | none | none |

### Secret scan (full history, 87 commits)

gitleaks (all refs) plus a custom pattern scan of every added line: private-key assignments, `sk-ant-`, QuickNode,
Alchemy and Infura URLs with a key, AWS and GitHub tokens, generic key assignments, and committed `.env` files. Each
hit was classified without printing its value.

| File | Commit(s) | Pattern | Triage |
|---|---|---|---|
| deployments/46630.json | 4ca53db8, 3bbe59f0 | generic-api-key (×9) | False positive: `token` / `mainnetToken` contract addresses |
| apps/api/README.md | 3bbe59f0 | generic-api-key | False positive: a token address |
| apps/console/test/livePrices.test.tsx, etfs.test.tsx | ab83e7c4, d01b562a | generic-api-key | False positive: addresses |
| apps/extension/test/journal.test.tsx | 80ec23bc | generic-api-key | False positive: an address |
| apps/extension/e2e/mockApi.ts | 6e6ee765 | generic key assignment | False positive: placeholder addresses |
| script/test-merge-deployment.sh | 29651467 | generic-api-key | False positive: addresses (ETF stand-in tokens and placeholders) |
| apps/extension/wxt.config.ts | ca62a8d4, 94f18ea0 | generic-api-key | False positive: the manifest `key`, the extension's public key, which pins its ID |
| apps/api/test/unit/chartLens.test.ts | 9dbe6a7f | anthropic key, generic | Placeholder (`sk-ant-` plus placeholder text, 8 distinct characters). Removed in a9f94ce. |
| apps/api/test/unit/{streaming,voiceConsistency,voice,assemblyai}.test.ts | 6a0bda6, 1aff807, 0e4cd03, ed5ef8f, 09830b6 | generic-api-key | A 40-hex `KEY` passed as `DEEPGRAM_API_KEY` to tests with a mocked `fetch`. That is the shape of a Deepgram key. It is described as a made-up "realistic-looking" fake and was replaced by `"deadbeef".repeat(5)` in **a9f94ce** ("tests: no realistic-looking fake credentials"). It is no longer in HEAD. **See L-12:** confirm it was never the live key. |

No `.env` file was ever committed (only `.env.example` files), and no private key appears in history. The previous
release scans (scan.py and gitleaks over `origin/main..HEAD`) were also clean.

## 3. Findings

Severity follows the brief. The **≤30 min** column applies to findings that need no redeploy. It says whether the fix
is safe to make in under 30 minutes without risking the live demo, and why.

| ID | Severity | Area | File:line | Issue | Fix | Requires redeploy | Status | ≤30 min, safe for the demo? |
|---|---|---|---|---|---|---|---|---|
| **C-1** | **Critical (testnet deployment configuration)** | Contract / deployment | `src/GlanceVault.sol:496-503`; `src/testnet/TestPriceFeed.sol:48`; `src/testnet/StockDesk.sol:126,150-155`; `apps/api/src/keeperInProcess.ts:4`; `docs/DEPLOY.md:46-47` | The testnet feeds and both StockDesks are owned by `0xca6A…aDFF` (on-chain reads), and the keeper runs on the API host with that key (`KEEPER_IN_PROCESS=1`). A sell's cap notional and slippage floor are `tokensIn × oraclePrice`. So whoever holds the API server can set a near-zero price, sell every stock token in a vault through the desk inside the caps, and withdraw the stock from the desk. Buys stay capped in USDG spent: at most $500 a day lost per vault. | **V3:** a per-update price deviation bound on the feed, plus a sell cap counted in tokens or measured against the last accepted price. **Now (ops):** the keeper key is never on the API host; move feed and desk ownership to a key off that host. | Contract part: yes. Ops part: no. | **Acknowledged, mainnet design unaffected** (contract code is correct for a trusted oracle; mainnet uses Chainlink feeds no Glance key can write). Fix in V3. | n/a (decision: no change and no transactions now) |
| M-1 | Medium | API | `apps/api/src/tradeAuth.ts:62, 145-148` | Trade nonces are kept in memory. A restart inside a signed request's deadline window (60 s plus 5 s skew) forgets them, so a captured signed trade could be replayed once. The replay can only repeat a trade the user already signed, inside the vault caps. | Persist recent nonces to `DATA_DIR`, or refuse signed requests for 65 s after boot. | No (API deploy only) | Fix before deadline | **Yes.** A 65 s boot guard is a few lines in one file with an existing test file. The only effect is trades refused for about a minute after each deploy. |
| M-2 | Medium | API | `apps/api/src/rateLimit.ts:9-12`; `config.ts:164`; `faucet.ts:163-165` | With `TRUST_PROXY=true`, the client IP is the **first** `X-Forwarded-For` entry, which the client controls unless Railway overwrites it. Every per-IP limit could be spoofed, including the faucet's 5 per hour per IP. | Take the right-most hop that Railway's proxy appends (or its real-IP header), after checking Railway's behaviour. | No | Fix before deadline | **No.** It depends on Railway's header behaviour, which needs checking against live traffic first. Getting it wrong puts every user behind one IP and locks out the faucet and the API. |
| M-3 | Medium | API | `apps/api/src/voice/routes.ts:426-470`; `app.ts:259` | The rate limit counts WebSocket upgrades, not open sockets. One IP can hold many live STT streams and use up the day's STT meter, which leaves everyone on "Voice is resting". Spend stays bounded by `meters.stt`. | Cap concurrent sockets per IP and per session (for example 2), and close the oldest. | No | Fix in V3 | **No.** It touches the live voice path, which is under a code freeze and is the demo's main surface. |
| M-4 | Medium | API | `apps/api/src/faucet.ts:8-12, 157-167, 193, 205` | Faucet farming: new addresses are free, so the real limits are the per-IP rule (spoofable, see M-2) and the daily total (0.01 ETH and 200 USDG). One actor can take each day's allowance with about 10 addresses. The faucet currently has funds for about 1 more user. | Gate the faucet behind proof of use (a linked vault, or a signed console session), plus M-2. | No | Fix before deadline | **No.** It changes the onboarding flow the demo depends on. Refilling the faucet is the safe short-term step. |
| M-5 | Medium | Extension | `apps/extension/entrypoints/background.ts:80-84, 257` | The background's `api` relay signs `/trade` and `/trade/basket` with the session key for **any** sender, and never checks `sender.id` or `sender.url`. Web pages can't reach it today: there is no `externally_connectable`, and content scripts run in an isolated world. But any future content-script bug would become a signed-trade primitive, bounded only by the vault caps. | Check `sender.id === browser.runtime.id`. For `/trade` requests from content scripts, require a confirm token from the in-page card's tap (or route signing through an extension page). | No (extension release) | Fix in V3 | **No.** In-page buy cards send trades from the content script, so a sender rule can break buying. It needs a design and an extension release with real-browser QA. |
| M-6 | Medium | Console | `apps/console/app/(console)/link/page.tsx:40, 54-63`; `lib/link.ts:11-17` | `/link?vault=…&session=…` signs a link for whatever session address is in the URL. A phishing link can get an owner to authorise an attacker's session key. That key could then ask the agent to trade inside the caps, never withdraw. The owner still has to sign in their wallet. | On `/link`, compare `session` with the extension's HELLO `sessionAddress` (`useGlanceExtension`), show a strong warning (or block) on a mismatch or with no extension, and show the vault's caps on that screen. | No (console deploy) | **Fixed (warning, not a block)**: `/link` shows "Only continue if you opened this link from your own Glance extension. Session key: 0x1234…abcd" above the sign button (`link/page.tsx`, `lib/link.ts` `linkWarning`; test `link.test.tsx`) | **Yes, as a warning only.** A non-blocking banner when the address differs from HELLO is console-only UI with no change to the signing path. Blocking is riskier (users without the extension) and should wait. |
| M-7 | Medium | Extension | `apps/extension/wxt.config.ts:45` | `web_accessible_resources` match `<all_urls>`, and the extension ID is pinned. Any site can probe `chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl/glance-mark.png` to detect that Glance is installed (fingerprinting). | Set `use_dynamic_url: true` and narrow the resources and matches. | No (extension release) | Fix in V3 | **No.** `chart-mount.js` and the fonts are loaded from the content script on every page, and a dynamic URL changes how they resolve. That needs a real-browser pass on the chart cases. |
| L-1 | Low | Contract | `src/RollingSpendLib.sol:76`; `GlanceVault.sol:462, 510` | Each side's window holds 32 distinct timestamps. A compromised agent can make 32 dust trades in separate blocks and lock agent trading for 24 h (`SpendBufferFull`). This can only stop trading, never move value. | Minimum trade notional, or merge entries per hour. | Yes | Fix in V3 | n/a (redeploy) |
| L-2 | Low | Contract | `src/MarketStatusLib.sol:136-148`; `GlanceVault.sol:496, 650-652` | Rounding: a sell's notional and both slippage floors round down, in the agent's favour by under one raw unit per trade. Same-block sells share one window entry, so the error doesn't compound beyond dust. | Round notional up, and round floors up. | Yes | Fix in V3 | n/a (redeploy) |
| L-3 | Low | API | `apps/api/src/app.ts:319-322` | `/session/list` is public. It returns any vault's linked session addresses and link times. These are public keys only. | Require the owner's signature, or return only what the console shows. | No | Fix in V3 | **No.** The console's "Linked browsers" list reads it. Changing the contract breaks that page unless both deploy together. |
| L-4 | Low | API | `apps/api/src/app.ts:303-306` | The admin token is passed as `?admin=`. The app's logger redacts it, but proxy logs and browser history may keep it. The comparison is constant-time. | Accept it in an `Authorization` header. | No | **Fix in V3**: no caller in the repo, but the documented use is an operator opening `/health?admin=` in a browser (DEPLOY.md:177), and bookmarks or monitors outside the repo may rely on it, so the query string stays for now | **Yes.** It only affects the operator's `/health` calls. Accept both forms for one release. |
| L-5 | Low | API | `apps/api/src/app.ts:513, 519`; `errorDetail.ts:10-14` | Error `detail` (contract function, RPC method, status, first line of the provider's message) is returned to any caller. URLs are scrubbed, but the provider's wording may reveal the plan or account tier. | Return `detail` only outside production, or only to admin. | No | Fix in V3 | **No.** The extension logs `detail` to diagnose chain-read failures (0.1.7). Removing it now costs field debugging during the demo. |
| L-6 | Low | API | `apps/api/src/config.ts:160`; `index.ts:41` | The default CORS list includes `http://localhost:3000` even in production (it only warns). | Drop localhost when `NODE_ENV=production`. | No | **Fixed**: production default is the extension plus `https://glance-evm-console.vercel.app`, and localhost origins are dropped in production even when listed (`config.ts` `corsOriginsFor`; test `limits.test.ts`) | **Yes.** Production sets `CORS_ORIGINS` explicitly, so the default isn't used there. It's a one-line guard. |
| L-7 | Low | API | `apps/api/src/compareAny.ts:20`; `tradeAuth.ts:62-63`; `faucet.ts:126`; `rateLimit.ts:35-37` | In-memory maps grow without a size cap. They are pruned only now and then, or by TTL. | LRU caps (for example 10k entries). | No | Fix in V3 | **Yes, but low value.** Each is a size check in one place; do it only if time is left. |
| L-8 | Low | API | `apps/api/src/faucet.ts:61-96`; `sessions.ts:81-95` | The "once per address" faucet store and the session nonces are JSON files. Without a persistent `DATA_DIR` volume, a redeploy resets them, and the nonce file grows forever. | Confirm the Railway volume at `/data`; move to SQLite later. | No | Fix before deadline (verify only) | **Yes.** Checking that `DATA_DIR=/data` is mounted is a dashboard check, with no code. |
| L-9 | Low | Extension | `apps/extension/components/Why.tsx:103, 128`; `Portfolio.tsx:248, 281` | `href`s come from API or news data (`s.url`, `src.url`, `entry.page.url`) with no scheme check, and the extension runs **React 18.3.1**, which only warns on `javascript:` URLs (React 19 blocks them). A poisoned news URL would run in the host page on click. | Render only `https?:` hrefs (`isHttpUrl()` at render). | No (extension release) | Fix before deadline | **Yes.** A pure render-time guard in two components with unit tests. It only drops non-http links. |
| L-10 | Low | Extension | `apps/extension/entrypoints/options/main.tsx:146-148` | The settings `consoleUrl` accepts any URL scheme (`javascript:`, `data:`). The only person it can hurt is the user who sets it. | Require `https?:`. | No (extension release) | Fix before deadline | **Yes.** A one-line validation. |
| L-11 | Low | Extension | `apps/extension/lib/handshake.ts:123-128` | `GLANCE_SET_VAULT` is accepted from any script on the console origin with no owner proof. An XSS or third-party script on the console could point the extension at another vault. Trading still needs an owner-signed link to this browser's session. | Confirm in the extension when the vault changes. | No | Fix in V3 | **No.** It changes the setup handshake the onboarding flow relies on. |
| L-12 | Low | Repo history | `apps/api/test/unit/streaming.test.ts` @ ed5ef8f (and 4 other commits; see the secret scan) | A 40-hex fake Deepgram key sat in test files until a9f94ce. The commit message calls it a fake, but it looks real. | Confirm it isn't (and never was) the live `DEEPGRAM_API_KEY`; rotate it if there's any doubt. | No | Fix before deadline (verify) | **Yes.** It's a dashboard check or key rotation, with no code. |
| L-13 | Low | Console | `apps/console/next.config.ts` | No security headers. There is no `frame-ancestors`, so the signing UI could be framed for clickjacking, and there is no Referrer-Policy and no CSP. | `headers()`: `frame-ancestors 'none'` (or `X-Frame-Options: DENY`) and `Referrer-Policy: strict-origin-when-cross-origin`. A full CSP later. | No (console deploy) | **Fixed**: `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` (only), `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff` on every route (`next.config.ts`; test `securityHeaders.test.ts`) | **Yes for frame-ancestors and Referrer-Policy.** Neither affects wallet connectors. **No for a full CSP**, which can break WalletConnect or RainbowKit. |
| L-14 | Low | Console deps | pnpm audit: `ws` (via WalletConnect) | High advisory on a transitive Node `ws` (see §2). | `pnpm.overrides`: `"ws": ">=8.21.0"`. | No | **Fixed**: pnpm override `ws@>=8.0.0 <8.21.0` to `8.21.0` (`pnpm-workspace.yaml`); `pnpm audit` shows no High | **Yes, if the console build and tests pass.** It's a lockfile-only change; check `pnpm --filter console build` before pushing. |
| I-1 | Info | Extension | `apps/extension/lib/session.ts:14` | The session private key sits in plaintext in `chrome.storage.local`. This is normal for MV3 and bounded by the vault caps (sessions can't withdraw, links last at most 30 days, the owner can revoke). | Optional: keep it in `storage.session`, or add a passcode. | No | Acknowledged | n/a |
| I-2 | Info | Extension | `apps/extension/lib/settings.ts` (`apiBaseUrl` in `storage.sync`) | A poisoned browser sync could redirect signed requests to another API. They are still bound by body hash, a 45 s deadline and a nonce. | Keep `apiBaseUrl` in `storage.local`. | No | Acknowledged | n/a |
| I-3 | Info | API | `packages/core/src/rpc.ts:61, 82-114` | The 40 calls/s limiter is per process. A second Railway replica (`numReplicas` is 1 today) would exceed QuickNode's 50/s. | Keep one replica, or share the limit. | No | Acknowledged | n/a |
| I-4 | Info | Contract | `src/GlanceVaultFactory.sol` | The V1 factory is still live alongside V2. It is correct, and the console uses V2. | Note it in the docs. | No | Acknowledged | n/a |
| I-5 | Info | Contract | `src/MarketStatusLib.sol:9-21` | The closed-market cut (25%) is inferred from feed age. It is only as good as the feed's heartbeat and freshness settings (deployed: 20 h open and 96 h closed on the example vaults, read on chain as 72000 and 345600 s). | Documented in the code; keep it per feed. | No | Acknowledged | n/a |

**Not found (checked):**
- no funds path to anyone but the owner;
- no unchecked ERC-20 return (SafeERC20 throughout);
- no approval left behind;
- no fee-on-transfer under-count (balance deltas everywhere, and `DepositShortfall` in the factory);
- no way for the agent to change limits, approvals, pause, expiry or feeds;
- no SSRF;
- no HTML sinks with page or model text;
- no `externally_connectable`;
- no key in any response or log.

## 4. What is already strong

| Guarantee | Why it holds (code) | Proof (test) |
|---|---|---|
| **The agent can never withdraw, and funds only ever go to the owner** | `withdraw` is `onlyOwner` and sends only to the immutable `owner` (`GlanceVault.sol:283-288`, `97`). Swaps deliver to `address(this)` (`:468`, `:514`). The agent has no other external function. | `test_agentCannotCallAnyOwnerFunction` (GlanceVault.t.sol:200), `test_agentCannotUseUnapprovedRouterAsWithdrawal` (:241), `test_maliciousRouter_cannotWithdraw` (:258), `test_revert_withdraw_nonOwner` (:178), `invariant_agentHoldsNothing`, `invariant_valueConserved` (invariant suite :139, :151) |
| **Buy caps are measured in USDG actually spent** | A buy's notional is `usdgIn`, the exact amount pulled (`:449`, `:462`, `:467`). The per-trade cap is checked before the 24 h window (`:612-624`). | `testFuzz_buyNeverExceedsPerTradeCap` (:1106), `test_revert_buy_overRollingDailyCap` (:324), `test_rollingWindow_partialExpiry` (:586), `invariant_buyWindowWithinCap` (invariant :113) |
| **Sell caps are separate and counted at the oracle value** (subject to C-1 on testnet) | `:496-499`, `:510`. | `test_revert_sell_overPerTradeCap` (:675), `invariant_sellWindowWithinCap` (invariant :126) |
| **Closed market: 25% caps, half slippage** | `effectiveCaps` (`:553-564`) and `CLOSED_SLIPPAGE_DIVISOR` (`:605-607`). | `test_weekend_sameBuyRevertsOverReducedCap_smallerBuySucceeds` (:474), `test_weekend_dailyCapReducedAndIncludesWeekdaySpend` (:506), `test_weekend_slippageTightened` (:518), `test_weekend_reducesSellCaps` (:923), `test_marketClosed_eachTradeCappedAt25` (SellFlow.t.sol:105), `test_weekendCapZero_blocksAllClosedMarketTrading` (:1094) |
| **Slippage is enforced against the oracle, and the output is measured** | The floor check (`:452-456`, `:502-503`), then the balance delta against `minOut` (`:471-473`, `:517-519`). The router's return value is not trusted. | `test_buy_acceptsMinOutAtExactSlippageFloor` (:306), malicious-router tests (:247, :258) |
| **Stale or invalid prices refuse the trade** | A price ≤ 0 or a future timestamp reverts (`MarketStatusLib.sol:65-66`). STALE refuses (`GlanceVault.sol:599`). Sequencer down or in its grace period refuses (`:629-636`). | `test_revert_buy_staleOracle` (:391), `test_revert_sell_staleOracle` (:949), `test_read_staleIsReportedNotReverted` (MarketStatusLib.t.sol:118), sequencer tests (:1042) |
| **Pause stops every agent trade; owner withdrawals still work** | `_checkAndLoad` checks pause first (`:580`), and `withdraw` has no pause check (`:283`). | `test_revert_buy_paused` (:385), `test_revert_sell_paused` (:942), `test_withdraw_worksWhilePaused` (:170) |
| **Token and router allowlist** | `:588-593`. USDG can't be configured as a stock (`:638-641`). | `test_revert_buy_tokenApprovalRevoked` (:338), `test_revert_buy_unapprovedRouter` (:359), `test_revert_sell_unapprovedTokenAndRouter` (:955) |
| **Agent expiry and revoke** | `block.timestamp >= agentExpiry` refuses (`:585`). Expiry is limited to 30 days ahead (`:300`), and a revoke zeroes the agent (`:307-311`). The agent can't extend itself (setters are `onlyOwner`). | `test_revert_buy_expiredAgent` (:365), `test_revert_sell_expiredAgent` (:966), `test_revert_buy_revokedAgent` (:372), `test_setAgent_validation` (:1052) |
| **Check order is fixed: pause, agent, token, router, oracle, caps** | `:578-608` | `test_checkOrder_isPauseAgentTokenRouterOracleCaps` (:434) |
| **Reentrancy and approvals** | `nonReentrant` on deposit, withdraw, buy and sell. `forceApprove(router, amount)` is reset to 0 after each swap (`:467-469`, `:513-515`). SafeERC20 throughout. OpenZeppelin **v5.7.0**. | `test_maliciousRouter_cannotReenter` (:247), `invariant_noLingeringAllowance` (invariant :145) |
| **Factory V2 never holds rights or funds** | The owner is `msg.sender` and immutable. USDG goes straight to the precomputed CREATE2 address, and short deliveries revert (`GlanceVaultFactoryV2.sol:51-63`). One vault per owner. | `test_oneTx_onePerOwner` (V2.t.sol:317), donation tests (:558, :577, :601), `test_oneTx_theAgentCanTradeImmediately` (:287) |
| **Deployed code is this code** | Exact runtime bytecode match for the factory (§2). | none |
| **Every state change emits an event; custom errors and NatSpec throughout** | Events at `GlanceVault.sol:143-186` cover every setter and trade. The only silent state change is window pruning. | none |
| **Trades need a user-linked, signed request** | The API signs only for a session key the owner linked with an on-chain-verified EIP-712 signature (`apps/api/src/sessions.ts:141-189`). Each request is signed over vault, token, amount, side, slippage, a body hash, a deadline of at most 60 s and a single-use nonce (`tradeAuth.ts:93-96, 113-150`). | API unit tests (`apps/api/test`) |
| **Prompt injection can't choose a trade** | Show-me output has no trade tag (`packages/core/src/showme.ts:55-62`). Page text is passed in delimited blocks marked as content (`apps/api/src/showme.ts:195-224`). Voice intents must name a catalog symbol and an amount the user actually said (`voice/intent.ts:268-349`). `/voice/command` never trades. **The on-chain vault limits are the final backstop**: even a fully subverted API can only make capped, oracle-priced trades back into the vault, never a withdrawal (with C-1's testnet caveat). | none |
| **Keys stay on the server** | The agent key is loaded in one place (`signer.ts:35-37`) and only its address is logged (`index.ts:22`). The keeper refuses to run with the agent key (`keeperInProcess.ts:38-39`). Config errors never echo values (`config.ts:256-258`). Error details are URL-scrubbed and capped (`errorDetail.ts:10-14, 37`). Query strings are redacted from the log (`app.ts:145-147`). | none |
| **No Opus** | The default model is `claude-haiku-4-5` (`llmBudget.ts:21`, `config.ts:103`), and chart vision uses `claude-sonnet-4-5` (`context.ts:18`). Any model name containing "opus" is swapped for Haiku unless `ALLOW_OPUS=1` (`llmBudget.ts:29-36`). No Opus ID is hard-coded anywhere in `apps/api` or `packages/core`. | none |
| **RPC pacing** | 40 calls/s per endpoint, counting each call in a batch, with batches of 20 (`packages/core/src/rpc.ts:51, 61, 82-114`), against QuickNode's 50/s. | core rpc tests |
| **Extension: minimal permissions, no HTML sinks** | Permissions are `storage`, `sidePanel` and `offscreen`. Host permissions are localhost plus the API origin, with optional runtime grants (`wxt.config.ts:31-33`). There is no `externally_connectable`. Labels use `textContent` (`chartLayer.ts:300`, `showDraw.ts:198`). The console↔extension handshake checks window, origin and fields, and the session key never leaves the background (`handshake.ts:47-67, 115-149`). | `apps/extension/test` |
| **Console: right chain before any signature** | Writes are gated on owner and chain (`components/WriteGate.tsx:16-21`). Every owner transaction is simulated first and pinned to `CHAIN_ID` (`useOwnerTx.ts`). The EIP-712 domain pins chain and vault. Wallets that can't switch (Phantom) are refused clearly (`lib/walletSupport.ts`). | `apps/console/test/walletSupport.test.tsx` and others |
