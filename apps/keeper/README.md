# Feed keeper

This keeps Glance's testnet `TestPriceFeed` stand-ins current. Each pass copies every live Chainlink feed on Robinhood
Chain **mainnet** onto its testnet stand-in: **both the price and that feed's own `updatedAt`, never "now"**.

Copying the real timestamp keeps the stand-ins honest. They are fresh while the real market trades and freeze when it
closes, so the vault's weekend guard works from real data. The reasoning and the measured update gaps are in
[docs/CHAIN_NOTES.md](../../docs/CHAIN_NOTES.md#the-mainnet-mirror-how-the-stand-in-feeds-stay-honest).

NFLX has no Chainlink feed. It mirrors a Yahoo Finance quote and uses the quote's own market time as `updatedAt`.

```sh
make keeper          # one pass (uses PRIVATE_KEY from the root .env, which owns the feeds)
make keeper-watch    # every 120s until Ctrl-C
make keeper-pause    # creates keeper.paused: the keeper writes nothing (commit it to pause GitHub Actions too)
make keeper-resume   # removes it
make feeds           # every feed's price, age, market state and source, via the API's /health
```

- **Configuration:** the keeper needs `KEEPER_PRIVATE_KEY`, `TESTNET_RPC_URL` and `MAINNET_RPC_URL`. It stops with a
  clear message if one is missing. `make keeper` fills them from the root `.env` and the public RPCs.
- **Safety checks:** before writing, it confirms that each target is a `TestPriceFeed` owned by its key, that the
  decimals match mainnet, and that both RPCs are on the expected chains.
- **What it writes:** it skips unchanged feeds and holds any reading it cannot mirror safely (non-positive, or
  timestamped ahead of the testnet clock).
- **Logging:** it never logs the key.

The schedule is `.github/workflows/keeper.yml`, every 5 minutes. It needs the repository secrets
`KEEPER_PRIVATE_KEY`, `ROBINHOOD_TESTNET_RPC_URL` and `ROBINHOOD_MAINNET_RPC_URL`.

Addresses come from `deployments/46630.json` (testnet feeds) and `config/price-sources.json` (mainnet feeds). The API
and `script/fetch-prices.sh` share the same config file.
