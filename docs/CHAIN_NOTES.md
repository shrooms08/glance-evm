# Chain notes: what is real, what is ours

Glance uses real infrastructure wherever it exists on the target testnets and ships a clearly labelled stand-in
everywhere else. This page records what we found, how each address was checked, and where it came from.

Researched 2026-09-23, Robinhood Chain testnet block ~123,140,000. "Verified" means we called the address over RPC:
it has code, and token metadata (`name`, `symbol`, `decimals`) or feed data (`decimals`, `latestRoundData`) came
back as listed.

## What runs on real contracts, what is a stand-in, and why

- **Glance's own contracts** (vault, factory, libraries) are the production code on every chain.
- **Stock Tokens are real** on Robinhood Chain testnet: the five tokens the official faucet hands out.
- **Paxos USDG is real, and the vault is deployed against it.** On Robinhood Chain testnet the deploy script creates
  `demoVaultPaxosUSDG` on the real Paxos USDG, with the same token approvals, limits and freshness settings as the
  public demo vault. `test/fork/GlanceVaultFork.t.sol` runs the whole vault flow against that real USDG and the real
  Stock Tokens on a fork: deposit, buy, sell, owner withdraw, agent withdraw refused. It repeats the flow on a
  Robinhood mainnet fork against the real Chainlink TSLA feed (`make test-fork`).
- **The interactive demo uses a stand-in USDG** (`TestUSDG`, `demoVaultTestUSDG`). Nothing hands out Paxos USDG on
  testnet (the organizers confirmed there is no faucet), so the Paxos vault is configured but unfunded, and a judge
  could not fund it. That is the only reason for the stand-in.
- **Prices mirror Chainlink mainnet, including the time.** Chainlink has no feeds on Robinhood testnet, so each stock
  has a `TestPriceFeed` stand-in. A keeper (`apps/keeper`) copies the live Chainlink feed on Robinhood mainnet onto it
  every few minutes: **both the price and that feed's own `updatedAt`, never "now"**. See
  [The mainnet mirror](#the-mainnet-mirror-how-the-stand-in-feeds-stay-honest) below. NFLX has no Chainlink feed, so
  it mirrors a public quote and that quote's own market timestamp instead.
- **The trading venue is a stand-in** (`StockDesk`) because no DEX pool holds these tokens on testnet.

## Summary

| Component | Robinhood Chain testnet (46630) | Arbitrum Sepolia (421614) |
| --- | --- | --- |
| Stock tokens (TSLA, AMZN, PLTR, NFLX, AMD) | **REAL**: official faucet Stock Tokens | STAND-IN: `TestStockToken` |
| USDG | **REAL** Paxos USDG for `demoVaultPaxosUSDG` (configured, unfunded); STAND-IN `TestUSDG` for the fundable demo vault | STAND-IN: `TestUSDG` |
| Stock price feeds | STAND-IN: `TestPriceFeed`, seeded from live Chainlink **mainnet** prices | STAND-IN: `TestPriceFeed` |
| L2 sequencer uptime feed | None exists: check left disabled | None exists: check left disabled |
| Trading venue | STAND-IN: `StockDesk` (no DEX pools exist); a second desk quotes Paxos USDG for the Paxos vault | STAND-IN: `StockDesk` |
| Vault, factory, libraries | Glance production code | Glance production code |

The stand-ins live in `src/testnet/`. Each one says so in its header, the deploy script prints `[STAND-IN]` or
`[REAL]` next to every address, and every `TestPriceFeed.description()` starts with `TEST FEED`.

## Robinhood Chain testnet (chain id 46630)

RPC `https://rpc.testnet.chain.robinhood.com`, explorer `https://explorer.testnet.chain.robinhood.com` (Blockscout).

### Stock Tokens: real, used

| Symbol | Address | Decimals | Status | Evidence |
| --- | --- | --- | --- | --- |
| TSLA | `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` | 18 | **Verified, used** | name "Tesla"; in the official faucet's token list |
| AMZN | `0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02` | 18 | **Verified, used** | name "Amazon"; in the faucet's token list |
| PLTR | `0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0` | 18 | **Verified, used** | name "Palantir Technologies"; in the faucet's token list |
| NFLX | `0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93` | 18 | **Verified, used** | name "Netflix"; in the faucet's token list |
| AMD | `0x71178BAc73cBeb415514eB542a8995b82669778d` | 18 | **Verified, used** | name "AMD"; in the faucet's token list |
| Faucet | `0x8762F93772c663c6a88Ba50900bd5381df2717Be` | - | **Verified** | verified `Faucet` contract; `getFullTokenList()` returns exactly the five tokens above |

How we know these are the official tokens and not one of the many look-alikes on testnet (the explorer lists at
least three community "TSLA Test Stock" copies, plus Aave and Edel wrappers):

- The verified `Faucet` contract's `getFullTokenList()` returns exactly these five addresses. One faucet claim
  (e.g. tx `0xa1b73b29…d0db549`) mints 5 of each to the claimer, plus 0.01 ETH.
- All five were deployed by the same address (`0x2DD5b0Ea…e5Da`) as `BeaconProxy`s behind one verified `Stock`
  implementation (`0xBd14156E…57DA`). They have identical supply (~6.19M) and 220,000 to 290,000 holders each.
- Only the faucet can mint them. `mint` from any other address reverts with
  `AccessControlUnauthorizedAccount`, so the StockDesk can only hold what the deployer claims from the faucet.
- They are separate deployments from the mainnet Stock Tokens: the addresses and bytecode differ.

Sources: explorer token search and token pages (`/api/v2/search?q=TSLA`, `/api/v2/tokens/<address>`), faucet
contract page on the explorer, and the Arbitrum Foundation guide, which says the testnet "uses real faucet Stock Tokens
for TSLA, AMZN, and NFLX with mock Chainlink feeds"
(https://blog.arbitrum.foundation/build-your-first-dapp-on-robinhood-chain/). The faucet UI is
https://faucet.testnet.chain.robinhood.com. It rate-limited our automated requests (HTTP 429), so the token list
above comes from the faucet contract itself.

### USDG: real Paxos USDG, used by a configured but unfunded vault

| Candidate | Address | Status | Evidence |
| --- | --- | --- | --- |
| "Global Dollar" (USDG, 6 dp) | `0x7E955252E15c84f5768B83c41a71F9eba181802F` | **Verified, used by `demoVaultPaxosUSDG`** | Proxy bytecode is byte-identical to mainnet Paxos USDG (codehash `0x864cc9ad…`); implementation `USDG` verified on the explorer; moves only by `transfer` / `transferWithAuthorization`; no faucet |
| "USDG" (6 dp) | `0x915Ef7c9F9f80a69e3BE47A38EE0Bb47607103ec` | Community token, not used | Different bytecode; owner-controlled mint by `0x99F7F9d6…` |
| "USD Gold (testnet)", "Mock USDG" ×2, others | several | Community tokens, not used | Explorer search for `USDG` returns at least 8 contracts |
| `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | - | **Mainnet only** | Listed on docs.robinhood.com/chain/contracts. It is Paxos USDG on mainnet 4663 (verified there), with no code on testnet |

### The Paxos USDG demo vault

Nothing dispenses Paxos USDG on testnet (the organizers confirmed there is no faucet). So on chain 46630 the deploy
script creates two demo vaults:

| Vault | USDG | Funded | Purpose |
| --- | --- | --- | --- |
| `demoVaultTestUSDG` | `TestUSDG` stand-in | Yes, from `TestUSDG.faucet()` (1,000 per address per UTC day) | The clickable demo a judge can fund |
| `demoVaultPaxosUSDG` | Paxos USDG `0x7E955252E15c84f5768B83c41a71F9eba181802F` | **No**: no faucet exists for this token | The same vault code, approvals, limits and freshness settings, wired to the real stablecoin |

The Paxos vault is not a shortcut or a mock. It holds no funds only because nobody can obtain testnet Paxos USDG.
Two details:

- A `StockDesk` quotes exactly one USDG, so the Paxos vault has its own desk (`stockDeskPaxosUSDG`) over the same
  feeds and spread. It is listed but not stocked, because the few faucet Stock Tokens go to the fundable desk.
- The factory allows one vault per owner, so the script deploys the Paxos vault directly. It is the same `GlanceVault`
  contract.

What proves it works with the real token is `test/fork/GlanceVaultFork.t.sol`. It uses `deal()` to give a test user
real Paxos USDG, asserts that the balance really moved, and runs deposit, buy, sell, owner withdraw and a refused agent
withdraw against the real USDG and real Stock Tokens. `deal()` finds the balance slot of both the Paxos proxy and the
Stock Token beacon proxies without help, so no manual slot was needed.

Sources: https://docs.robinhood.com/chain/contracts, the explorer (`/api/v2/search?q=USDG`), RPC bytecode comparison
against `https://rpc.mainnet.chain.robinhood.com`.

### Chainlink price feeds: none on testnet

| Feed | Address | Status | Evidence |
| --- | --- | --- | --- |
| Any Robinhood testnet feed | - | **Does not exist** | Chainlink's docs list only "Robinhood Chain Mainnet" (`chains.ts`, `rddUrl feeds-robinhood-mainnet.json`); no testnet directory exists |
| Mainnet TSLA / USD proxy | `0x4A1166a659A55625345e9515b32adECea5547C38` | Mainnet only | "RHTSLA / USD", 8 dp, answer $380.2574; no code on testnet |
| Mainnet AMZN / USD proxy | `0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C` | Mainnet only | 8 dp, answer $255.591; no code on testnet |
| Mainnet PLTR / USD proxy | `0x820ABedFF239034956B7A9d2F0a331f9F075eB4c` | Mainnet only | 8 dp, answer $184.67245; no code on testnet |
| Mainnet AMD / USD proxy | `0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72` | Mainnet only | "RHAMD / USD", 8 dp, answer $621.105; no code on testnet |
| Mainnet USDG / USD proxy | `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` | Mainnet only | 8 dp, answer $1.00005 |
| NFLX / USD | - | **Does not exist on either network** | Not in Chainlink's Robinhood mainnet directory |

What we do instead: deploy one `TestPriceFeed` per stock and seed it with the **live mainnet Chainlink price**.
`make deploy-*` runs `script/fetch-prices.sh`, which reads the proxies above over mainnet RPC.

NFLX has no Chainlink feed to read, so the script fetches a free public quote: Yahoo Finance's chart API, then
Nasdaq's quote API as a fallback. At the time of writing that was $72.16. If both fail it uses `PRICE_NFLX` from
`.env`, and if that is missing too, NFLX is **skipped** (not listed on the desk or vault) rather than seeded with a
wrong price. Each stock in `deployments/<chainid>.json` records `priceSource` and `priceSourceKind`: `chainlink-live`,
`public-quote`, `env`, or `snapshot` (a dated Chainlink value used only if the mainnet read fails).

All mainnet feeds above report a 24 hour heartbeat (`heartbeat: 86400`) in Chainlink's directory.

Sources: https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood and
https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood (both render their tables client-side), and
the JSON they are built from: https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json and
https://github.com/smartcontractkit/documentation/blob/main/src/features/data/chains.ts. Robinhood's own
oracle page (https://docs.robinhood.com/chain/oracles-and-price-feeds) defers to Chainlink.

### L2 sequencer uptime feed: none

Chainlink's Robinhood directory (mainnet, the only network it lists) contains no "L2 Sequencer Uptime Status Feed".
The vault's check stays disabled (`sequencerUptimeFeed = address(0)`), and `SEQUENCER_UPTIME_FEED` turns it on if one
appears. Source: https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json.

### DEX liquidity: none for these tokens

The explorer shows at least four community Uniswap V3 factories (`0xd83F2d43…`, `0x0532989c…`, `0xa554c72A…`,
`0xB5C9ACbb…`) and four V2 factories (`0x0544EDB4…`, `0xa0B430f1…`, `0xA0267618…`, `0x1B3BaD7A…`). We queried all
eight for every pairing of the five Stock Tokens against both USDG candidates and WETH (`0x7943e237…`), at fee tiers
500, 3000 and 10000 on V3. **No pool or pair exists.** Robinhood's docs name Uniswap and Rialto as venues, but
neither has liquidity for these tokens on testnet, so Glance ships `StockDesk`, an oracle-priced desk.

### Other checks

- Mainnet exists: `https://rpc.mainnet.chain.robinhood.com` reports chain id 4663. Every asset in
  `https://api.robinhood.com/rhj/assets` (195 assets) is deployed on 4663 only. None has code on testnet 46630.
- EVM features: forge prints "EIP-3855 is not supported" for this RPC. That is a false positive. `eth_call` runs
  PUSH0, TSTORE/TLOAD and MCOPY successfully, while `INVALID` is rejected, so the `cancun` target is fine.
- Gas: base fee 0.01 gwei at the time of research.

## The mainnet mirror: how the stand-in feeds stay honest

Our `TestPriceFeed`s are stand-ins for Chainlink feeds that exist only on Robinhood Chain mainnet. A stand-in could
simply stamp the current time on each price, but that would lie. The vault reads a feed's age to tell whether the
market is open, so a 3am Sunday price stamped "now" would look like live trading and unlock full-size trades.

So the keeper copies **both the price and the real feed's own `updatedAt`**. Our testnet feeds then age exactly like the
real ones:

- they are fresh while the real market trades;
- they freeze when it closes;
- the vault's weekend guard switches on by itself from real data, with no simulation.

The rule lives in one pure function, `apps/keeper/src/mirror.ts`, with a unit test that fails if the keeper ever writes
the testnet clock instead of the source's timestamp.

| Symbol | Source | Mirrored from |
| --- | --- | --- |
| TSLA, AMZN, PLTR, AMD | `mainnet-mirror` | the Chainlink proxies in the Chainlink table above, recorded in `config/price-sources.json` |
| NFLX | `public-quote` | Yahoo Finance `regularMarketPrice`, with its `regularMarketTime` as `updatedAt` (no Chainlink NFLX feed exists) |

How it runs:

- **Once, locally or from cron:** `make keeper`.
- **Continuously while recording:** `make keeper-watch`, every 120 seconds.
- **Scheduled:** `.github/workflows/keeper.yml` runs it every 5 minutes on GitHub Actions.
- **Only writes what changed.** An unchanged feed is skipped, and each run logs every decision.
- **Writes nothing while paused.** It is paused while `keeper.paused` exists at the repo root (`make keeper-pause`), or
  while `KEEPER_PAUSED=1` is set. Commit the file to pause the scheduled run too. That is what `make weekend` needs: a
  feed frozen on purpose must not be restored by the next pass. `make weekday` resumes the keeper and restores the
  real data.
- **Visible from the API.** `GET /health` shows each feed's price, age, market state, source, and last on-chain write.

### What the real feeds' update pattern means for the vault

We sampled the last 60 rounds of each mainnet feed on 2026-09-23. The feeds update in bursts, often every few minutes,
with quiet stretches between them:

| Feed | Longest weekday gap seen | Weekend gap seen |
| --- | --- | --- |
| TSLA | 12.7 hours | 52.2 hours (Fri 19:48 to Mon 00:00 UTC) |
| PLTR | 17.8 hours | 52.0 hours (Fri 19:58 to Mon 00:00 UTC) |
| AMZN | 17.6 hours | 55.7 hours (Fri 16:19 to Mon 00:00 UTC) |
| AMD | 9.8 hours | not in the sample |

The vault's default freshness thresholds (OPEN up to 1 hour, CLOSED up to 80 hours) suit a feed that updates at least
hourly. With honest timestamps, the real feeds regularly go longer than an hour without an update on ordinary weekdays,
so under the defaults the vault often reads CLOSED on weekdays too. That fails safe (caps drop to 25%), but it does
not track market hours.

`make set-freshness OPEN_MAX_AGE=… CLOSED_MAX_AGE=…` sets per-token thresholds on the demo vaults. For these feeds,
**OPEN up to 20 hours** (above the longest weekday gap seen) and **CLOSED up to 96 hours** (above the longest weekend
gap, plus a long-weekend margin) read weekdays as OPEN and weekends as CLOSED.

The unavoidable trade-off: age alone cannot tell "closed" from "quiet", so after the last Friday update the vault reads
OPEN for up to the OPEN threshold before the weekend guard engages.

## Arbitrum Sepolia (chain id 421614)

RPC `https://sepolia-rollup.arbitrum.io/rpc`, explorer `https://arbitrum-sepolia.blockscout.com` (used for
verification; no API key needed).

| Component | Address | Status | Evidence |
| --- | --- | --- | --- |
| Robinhood Stock Tokens | - | **Do not exist** | Robinhood Stock Tokens live only on Robinhood Chain |
| Chainlink equity feeds (TSLA, AMZN, PLTR, NFLX, AMD) | - | **No on-chain feed** | Chainlink's Arbitrum Sepolia directory lists these only as Data Streams products (`...-Streams-...`, `proxyAddress: null`), which cannot be read through `AggregatorV3Interface` |
| L2 sequencer uptime feed | - | **Does not exist** | Absent from Chainlink's Arbitrum Sepolia directory (2,226 entries). Arbitrum One has `0xFdB631F5EE196F0ed6FAa767959853A9F217697D`, not usable on Sepolia |
| "Global Dollar" USDG | `0xFFC95faa3d63Cde504a05B567C600B78C0b41892`, `0xD30032951b5f48c39aE09782ADDD1c0B67FfbFeb` | Found, not used | Both have the same proxy bytecode as Paxos mainnet USDG, so we cannot tell which (if either) is Paxos's. Neither has a faucet |

Everything on Arbitrum Sepolia is therefore a stand-in except Glance's own contracts.

Sources: https://reference-data-directory.vercel.app/feeds-ethereum-testnet-sepolia-arbitrum-1.json,
https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-arbitrum-1.json,
https://arbitrum-sepolia.blockscout.com (`/api/v2/search?q=USDG`).

## Findings to review before mainnet

1. **Oracle freshness vs heartbeat (fixed in the contract; tune per feed).** See the measured update gaps in
   [The mainnet mirror](#the-mainnet-mirror-how-the-stand-in-feeds-stay-honest). The vault used to treat any feed older than 1 hour as CLOSED. The
   Robinhood mainnet equity feeds have a 24 hour heartbeat, so healthy feeds are often hours old: on 2026-09-23 at
   11:06 UTC, TSLA was 2.9 hours old and PLTR 17.8 hours old. The thresholds are now per token (`openMaxAge`,
   `closedMaxAge`, set with `setTokenFreshness`). The defaults stay at 1h / 80h, which suits the testnet stand-in
   feeds that are refreshed on deploy. **A mainnet deployment must set them per feed**, for example 26h / 96h for a
   24h-heartbeat feed. `test_mainnetFork_realFeedAt20Hours_defaultsVsHeartbeatConfig` shows the real TSLA feed at 20
   hours old reading CLOSED under the defaults and OPEN under the 24h configuration.
2. **USDG / USD is not exactly $1.** Mainnet reads $1.00005. The vault assumes 1 USDG = $1 (documented in
   `GlanceVault`). A mainnet version could read the USDG / USD feed.
3. **Stock Tokens are upgradeable.** Both testnet and mainnet tokens are beacon proxies controlled by Robinhood.
   They are allowlisted per token by the vault owner, so this is a trust assumption, not a vault bug.
