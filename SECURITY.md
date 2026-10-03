# Security

## Security model

- **Your vault is yours.** Each user has their own vault contract, and only its owner can deposit, withdraw or change
  its settings.
- **The agent key can only trade, and only within limits the chain enforces:**
  - a per-trade cap and a rolling daily cap;
  - 25% of those caps while the market is closed;
  - a slippage bound against the oracle;
  - only the tokens and routers the owner approved;
  - the owner's pause switch;
  - an expiry on the agent key.
- **The agent can never withdraw**, and it can never send funds anywhere but the vault. Every swap delivers back into
  the vault; withdrawals go only to the owner.
- **Buy caps are counted in USDG actually spent**, not in an estimate.

## Testnet note (C-1)

On testnet, prices come from our own keeper, and the keeper key currently runs on the same server as the agent key.
So on testnet, the sell caps trust our server.

Mainnet uses Chainlink feeds that no Glance key can write. V3 will:
- add a per-update price deviation bound;
- measure the sell cap against the last accepted price;
- keep the keeper key off the API host.

## Audit results

- Tests: 180 of 180 pass.
- Coverage: 100% line coverage on the production contracts.
- Deployment: the deployed factory's bytecode matches this repo.
- Slither: 0 real findings.

Full report: [docs/audit.md](docs/audit.md). The detailed model (sessions, signed trades, rate limits) is in
[docs/SECURITY.md](docs/SECURITY.md).

## Reporting a vulnerability

Open a GitHub issue marked **security**, or DM [@shroomsgotsol](https://x.com/shroomsgotsol) on X.
