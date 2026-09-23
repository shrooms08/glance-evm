# Glance EVM

Buy tokenized stocks from any headline, through an agent that cannot overspend.

Built for the Arbitrum Open House Singapore Buildathon (Sep 14 to Oct 4, 2026), targeting Robinhood Chain.

- An onchain vault holds the funds and enforces every limit: per-buy cap, rolling 24h caps for buys and sells,
  approved token list, agent expiry, pause, and a maximum slippage checked against the oracle price.
- A market guard reads each price's age: when the stock market is closed the vault cuts its caps to 25%, and when a
  price is too old it refuses to trade.
- The browser extension recognises companies on a page and buys in one tap, with no wallet popup.

Status: deployed on Robinhood Chain testnet (addresses in [deployments/46630.json](deployments/46630.json)). The demo
runs on real Paxos USDG.

## What is real, and what is ours

On Robinhood Chain testnet:

| Part | Real or ours | Why |
| --- | --- | --- |
| USDG | **Real Paxos USDG**, claimable by anyone at https://faucet.paxos.com/ | It exists on testnet |
| Stock Tokens (TSLA, AMZN, PLTR, NFLX, AMD) | **Real**: the official ones from the Robinhood faucet, https://faucet.testnet.chain.robinhood.com | They exist on testnet |
| Price feeds | **Ours**, mirroring the live Robinhood Chain **mainnet** Chainlink feeds, including their timestamps (NFLX, which has no Chainlink feed, mirrors a public quote) | The testnet has no Chainlink feeds |
| Trading desk | **Ours**: an oracle-priced desk holding real Stock Tokens and real USDG, not an AMM | No DEX pool exists for these tokens on testnet |
| Vault, factory, extension, API | Glance's own code | |

A second demo vault on our `TestUSDG` stand-in, with its own on-chain faucet, stays available as a fallback for anyone
without Paxos USDG. Every address, how it was verified, and the limits of each stand-in are in
[docs/CHAIN_NOTES.md](docs/CHAIN_NOTES.md).

## Try it yourself

You need a browser wallet (for example MetaMask) on Robinhood Chain testnet, and about 10 minutes.

1. **Add Robinhood Chain testnet** to your wallet: RPC `https://rpc.testnet.chain.robinhood.com`, chain ID `46630`,
   currency ETH, explorer `https://explorer.testnet.chain.robinhood.com`.
2. **Claim testnet ETH** (for gas) at https://faucet.testnet.chain.robinhood.com. The same claim also sends a few real
   Stock Tokens; you won't need them.
3. **Claim USDG** at https://faucet.paxos.com/ for Robinhood Chain testnet, to your wallet address.
   (No Paxos USDG? Use the TestUSDG fallback in step 4; it takes test USDG from its own faucet for you.)
4. **Create and fund your vault.** The console's **Get started** page does this from your wallet, one confirmation at a
   time (see [apps/console/README.md](apps/console/README.md)). Or from the command line, with
   [Foundry](https://getfoundry.sh) and this repository:
   ```sh
   git clone <this repository> && cd glance-evm && forge install
   cp .env.example .env            # put your testnet wallet's private key in PRIVATE_KEY
   make create-vault               # real Paxos USDG, deposits 10 USDG
   # or: make create-vault VAULT_USDG=test DEPOSIT=100   (TestUSDG fallback)
   ```
   It creates your vault, lets the Glance agent trade for it within the vault's limits ($100 per trade, $500 per day,
   25% of that when the market is closed), approves the five stocks with their price feeds, and deposits. It shows
   the transactions and asks before sending. Note the vault address it prints. You stay the owner: you can withdraw,
   pause or revoke the agent at any time.
5. **Install the extension**: follow [apps/extension/README.md](apps/extension/README.md) (load it unpacked in Chrome).
   In Glance's settings, set the **API base URL** to the Glance API you were given for judging (or run your own, see
   [apps/api/README.md](apps/api/README.md)) and paste **your vault address**. Click Save; the connection test should
   show the chain and fresh prices.
6. **Buy from a headline.** Open a news article about Tesla, Amazon, Palantir, Netflix or AMD. Hover the underlined
   name, pick $10, check the preflight, and confirm. The receipt links to your transaction on the explorer. Try $150
   to see the vault refuse it and explain why.

Just want to look? The extension defaults to our demo vault on real Paxos USDG, so steps 5 and 6 work without steps 1
to 4 (trades then spend the demo vault's USDG).

## Contracts and deployment

- `src/`: the vault (`GlanceVault`), its factories, and the libraries it uses. This is the production code.
  - `GlanceVaultFactory` creates a vault that its owner then configures with one transaction per setting.
  - `GlanceVaultFactoryV2` creates a vault already configured and funded, in one transaction. It deploys a
    `ConfiguredGlanceVault`, whose constructor applies every setting through the same internal functions as the
    owner setters: same checks, same errors, same events. The owner is `msg.sender` from the start. The deposit goes
    from the owner straight to the vault's CREATE2 address, so the factory never holds USDG, an allowance or a role.
    Both factories stay valid; `deployments/46630.json` records V2 under `factoryV2` once deployed.
- `src/testnet/`: clearly labelled stand-ins for what the testnets lack: `TestPriceFeed`, `StockDesk` (an
  oracle-priced demo venue, not an AMM), `TestUSDG` (the fallback's faucet token) and `TestStockToken` (Arbitrum
  Sepolia only).
- [docs/CHAIN_NOTES.md](docs/CHAIN_NOTES.md) lists every address we found on Robinhood Chain testnet and
  Arbitrum Sepolia, how each was verified, and what is real versus stand-in.

```sh
cp .env.example .env         # set PRIVATE_KEY, optionally AGENT_ADDRESS
make test
make dry-run-robinhood       # simulate, sends nothing
make deploy-robinhood        # deploy + verify on Blockscout; writes deployments/46630.json
make dry-run-factory-v2      # simulate deploying GlanceVaultFactoryV2 (sends nothing, needs no key)
make deploy-factory-v2       # deploy + verify it; records factoryV2 in deployments/46630.json
make fund-paxos              # stock the Paxos desk and fund the primary vault with real Paxos USDG (idempotent)
make check-vaults            # read-only: both demo vaults quote a $10 TSLA buy and pass the on-chain preflight
make seed                    # fund the TestUSDG fallback vault
make weekend                 # back-date the stand-in feeds to demo the closed-market caps
```

## Backend API

`apps/api` is the API the extension and the console use. It resolves companies in page text, reads prices and vault
state, quotes trades with an on-chain preflight, and places agent trades. Every contract error comes back as a sentence
the assistant can say. See [apps/api/README.md](apps/api/README.md).

```sh
pnpm install
pnpm --filter api dev       # http://localhost:8790
pnpm --filter api test
```

## Voice

Hold Option+V on any page and speak ("buy ten dollars of Tesla", "what's Tesla at"). Voice works in any Chromium browser,
including Brave and Arc, because transcription is server-side: the extension records in its own context, Deepgram
transcribes, Claude turns the words into an intent (validated against our catalog and against what was actually said),
and Deepgram Aura speaks the reply (Fish Audio optional). A spoken buy only opens the same confirm card as a typed one: nothing trades without
the tap, and every vault guard applies. Keys live only in `apps/api/.env`. See [apps/api/README.md](apps/api/README.md#voice).

## Feed keeper

`apps/keeper` mirrors the live Chainlink feeds on Robinhood Chain mainnet onto our testnet stand-in feeds. It copies
the price **and** each feed's own timestamp, so the testnet market opens and closes when the real one does. It runs
every 5 minutes on GitHub Actions, or locally with `make keeper` / `make keeper-watch`. See
[apps/keeper/README.md](apps/keeper/README.md).

## Console

`apps/console` is where a vault owner sees and controls their vault, and where anyone can check the guards are real:
balances and positions, every cap with used against remaining (market open and closed), the agent and its expiry,
limits, pause and revoke through the owner's own wallet, every trade next to every refusal, the prices and where
they come from, and a Get started page that creates a vault the way `make create-vault` does. It never touches the
agent key. See [apps/console/README.md](apps/console/README.md).

```sh
pnpm --filter api dev       # http://localhost:8790
pnpm --filter console dev   # http://localhost:3000
```

## Browser extension

`apps/extension` is the demo surface. A floating orb (or a docked side panel) finds companies in any article,
underlines them without touching the page, shows live prices on hover, and buys through the vault. When a guard
refuses a trade it shows why, as protection rather than an error. See [apps/extension/README.md](apps/extension/README.md)
for step-by-step installation.
