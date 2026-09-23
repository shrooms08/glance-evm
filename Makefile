# Glance EVM. Every target reads .env (copy .env.example). Deploy targets print their plan and ask before sending.
-include .env
export

NETWORK ?= robinhood

.PHONY: help build test test-fork fmt prices dry-run-robinhood dry-run-arbsepolia deploy-robinhood deploy-arbsepolia seed \
	verify-commands weekend weekday

help:
	@echo "make test                  forge fmt check + all offline tests"
	@echo "make test-fork             fork tests against real Robinhood Chain testnet and mainnet contracts"
	@echo "make prices                show the live Chainlink mainnet prices the stand-in feeds will be seeded with"
	@echo "make dry-run-robinhood     simulate the Robinhood Chain testnet deploy (sends nothing)"
	@echo "make deploy-robinhood      deploy + verify on Robinhood Chain testnet (46630)"
	@echo "make deploy-arbsepolia     deploy + verify on Arbitrum Sepolia (421614)"
	@echo "make seed                  fund the demo vault [NETWORK=robinhood|arbsepolia DEMO_RECIPIENT=0x...]"
	@echo "make verify-commands       print manual verification commands [NETWORK=...]"
	@echo "make weekend / weekday     back-date / refresh the stand-in feeds for the weekend demo [NETWORK=... SYMBOL=TSLA]"

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

weekday:
	@script/set-market.sh $(NETWORK) weekday $(or $(SYMBOL),all)
