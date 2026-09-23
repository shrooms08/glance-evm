# Glance EVM

Buy tokenized stocks from any headline, through an agent that cannot overspend.

Built for the Arbitrum Open House Singapore Buildathon (Sep 14 to Oct 4, 2026), targeting Robinhood Chain.

- An onchain vault holds the funds and enforces every limit: per-buy cap, rolling 24h cap, approved token list, agent expiry, pause, and a maximum price deviation checked against Chainlink.
- A weekend guard reads Chainlink's market status. When the stock market is closed and the price goes stale, the vault tightens caps and refuses trades.
- The browser extension recognises companies on a page and buys in one tap, with no wallet popup.

Status: in development. Contracts, deployed addresses and demo video to follow.

## Contracts and deployment

- `src/`: the vault (`GlanceVault`), its factory, and the libraries it uses. This is the production code.
- `src/testnet/`: clearly labelled stand-ins for what the testnets lack: `TestUSDG` (public faucet),
  `TestStockToken`, `TestPriceFeed`, and `StockDesk`, an oracle-priced demo venue (not an AMM).
- [docs/CHAIN_NOTES.md](docs/CHAIN_NOTES.md) lists every address we found on Robinhood Chain testnet and
  Arbitrum Sepolia, how each was verified, and what is real versus stand-in. On Robinhood Chain testnet, Glance trades
  the real faucet Stock Tokens (TSLA, AMZN, PLTR, NFLX, AMD) at prices mirrored from live Chainlink mainnet feeds.

```sh
cp .env.example .env         # set PRIVATE_KEY, optionally AGENT_ADDRESS
make test
make dry-run-robinhood       # simulate, sends nothing
make deploy-robinhood        # deploy + verify on Blockscout; writes deployments/46630.json
make seed                    # fund the demo vault
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

## Feed keeper

`apps/keeper` mirrors the live Chainlink feeds on Robinhood Chain mainnet onto our testnet stand-in feeds. It copies
the price **and** each feed's own timestamp, so the testnet market opens and closes when the real one does. It runs
every 5 minutes on GitHub Actions, or locally with `make keeper` / `make keeper-watch`. See
[apps/keeper/README.md](apps/keeper/README.md).
