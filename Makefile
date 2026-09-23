# Glance EVM. Every target reads .env (copy .env.example). Deploy targets print their plan and ask before sending.
-include .env
export

NETWORK ?= robinhood

.PHONY: help build test test-fork fmt prices dry-run-robinhood dry-run-arbsepolia deploy-robinhood deploy-arbsepolia seed \
	verify-commands weekend weekday keeper keeper-watch keeper-pause keeper-resume feeds set-freshness

TESTNET_RPC_URL ?= https://rpc.testnet.chain.robinhood.com
MAINNET_RPC_URL ?= https://rpc.mainnet.chain.robinhood.com
# The keeper signs with KEEPER_PRIVATE_KEY, falling back to the deployer's PRIVATE_KEY (the feeds' owner).
KEEPER_ENV = KEEPER_PRIVATE_KEY="$${KEEPER_PRIVATE_KEY:-$$PRIVATE_KEY}" TESTNET_RPC_URL="$(TESTNET_RPC_URL)" MAINNET_RPC_URL="$(MAINNET_RPC_URL)"

help:
	@echo "make test                  forge fmt check + all offline tests"
	@echo "make test-fork             fork tests against real Robinhood Chain testnet and mainnet contracts"
	@echo "make prices                show the live Chainlink mainnet prices the stand-in feeds will be seeded with"
	@echo "make dry-run-robinhood     simulate the Robinhood Chain testnet deploy (sends nothing)"
	@echo "make deploy-robinhood      deploy + verify on Robinhood Chain testnet (46630)"
	@echo "make deploy-arbsepolia     deploy + verify on Arbitrum Sepolia (421614)"
	@echo "make seed                  fund the demo vault [NETWORK=robinhood|arbsepolia DEMO_RECIPIENT=0x...]"
	@echo "make verify-commands       print manual verification commands [NETWORK=...]"
	@echo "make keeper                mirror the mainnet Chainlink feeds (price AND updatedAt) onto the testnet feeds, once"
	@echo "make keeper-watch          the same, every 120s, until Ctrl-C (use while recording)"
	@echo "make keeper-pause / resume stop / restart the keeper (creates / removes keeper.paused)"
	@echo "make feeds                 every feed's price, age, market state and source, from the API's /health"
	@echo "make weekend               back-date the feeds 30h to demo the closed-market caps (run make keeper-pause first)"
	@echo "make weekday               resume the keeper and restore the real mainnet prices and timestamps"
	@echo "make set-freshness         set per-token freshness on the demo vaults [OPEN_MAX_AGE=s CLOSED_MAX_AGE=s]"

build:
	forge build

test:
	forge fmt --check
	forge test --no-match-path "test/fork/*"

# Real Paxos USDG, real Stock Tokens and real Chainlink feeds, on forks. Needs network access.
test-fork:
	forge test --match-path "test/fork/*" -vv

fmt:
	forge fmt

prices:
	@script/fetch-prices.sh

dry-run-robinhood:
	@script/deploy.sh robinhood --dry-run

dry-run-arbsepolia:
	@script/deploy.sh arbsepolia --dry-run

deploy-robinhood:
	@script/deploy.sh robinhood

deploy-arbsepolia:
	@script/deploy.sh arbsepolia

seed:
	@. script/networks.sh $(NETWORK); \
	test -n "$${PRIVATE_KEY:-}" || { echo "PRIVATE_KEY is not set"; exit 1; }; \
	echo "== About to seed the Glance demo on $$NETWORK_NAME (chain $$CHAIN_ID)"; \
	echo "vault deposit  $${VAULT_DEPOSIT:-1000000000} raw USDG (default 1,000 USDG) from the vault owner"; \
	echo "demo USDG      $${DEMO_USDG_AMOUNT:-1000000000} raw to $${DEMO_RECIPIENT:-<nobody; set DEMO_RECIPIENT>}"; \
	forge script script/SeedDemo.s.sol --rpc-url $$RPC --private-key $$PRIVATE_KEY --broadcast

verify-commands:
	@script/verify-commands.sh $(NETWORK)

weekend:
	@script/set-market.sh $(NETWORK) weekend $(or $(SYMBOL),all)

# Restores the real data rather than stamping "now": if the real market is closed, the feeds stay closed.
weekday: keeper-resume keeper

keeper:
	@$(KEEPER_ENV) pnpm --silent --filter keeper once

keeper-watch:
	@$(KEEPER_ENV) pnpm --silent --filter keeper watch

keeper-pause:
	@touch keeper.paused
	@echo "Keeper paused locally (keeper.paused created). To pause the scheduled GitHub Actions keeper as well, commit and push keeper.paused."

keeper-resume:
	@rm -f keeper.paused
	@echo "Keeper resumed locally (keeper.paused removed). If you committed keeper.paused, delete it in git and push to resume GitHub Actions."

feeds:
	@curl -s $(or $(API_URL),http://localhost:8790)/health | jq -r '.feeds[] | "\(.symbol)\t$$\(.price.value)\t\(.marketState)\tage \(.age)\t\(.source)\tlast write \(if .lastWrite then "\(.lastWrite.agoSeconds)s ago" else "none" end)"' | column -t -s $$'\t'

set-freshness:
	@script/set-freshness.sh $(NETWORK) $(or $(OPEN_MAX_AGE),$(error set OPEN_MAX_AGE)) $(or $(CLOSED_MAX_AGE),$(error set CLOSED_MAX_AGE))
