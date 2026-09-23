#!/usr/bin/env bash
# Preflight, confirm, then run script/Deploy.s.sol with Blockscout verification. Usage: script/deploy.sh <network> [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."
source script/networks.sh "${1:?usage: script/deploy.sh <robinhood|arbsepolia> [--dry-run]}"
DRY_RUN="${2:-}"

[[ -n "${PRIVATE_KEY:-}" ]] || { echo "PRIVATE_KEY is not set (copy .env.example to .env)"; exit 1; }
actual=$(cast chain-id --rpc-url "$RPC")
[[ "$actual" == "$CHAIN_ID" ]] || { echo "RPC $RPC reports chain $actual, expected $CHAIN_ID"; exit 1; }
deployer=$(cast wallet address --private-key "$PRIVATE_KEY")

prices=$(script/fetch-prices.sh)

echo "== About to deploy Glance to $NETWORK_NAME (chain $CHAIN_ID)"
echo "rpc        $RPC"
echo "deployer   $deployer   balance $(cast balance "$deployer" --ether --rpc-url "$RPC") ETH"
echo "agent      ${AGENT_ADDRESS:-<none; set AGENT_ADDRESS in .env to authorise one>}"
echo "usdg       ${USDG_ADDRESS:-TestUSDG stand-in with a public faucet}"
echo "sequencer  ${SEQUENCER_UPTIME_FEED:-<none; no Chainlink uptime feed exists on this chain>}"
if [[ -f "deployments/$CHAIN_ID.json" ]]; then
  echo "existing   deployments/$CHAIN_ID.json found: recorded contracts are reused, feeds re-priced, desk topped up"
else
  echo "existing   none: fresh deploy"
fi
echo "plan       $PLAN"
echo "prices     (8 decimals, seeded into TestPriceFeed stand-ins)"
echo "${prices:-  <none fetched; using the dated snapshot in Deploy.s.sol>}" | sed 's/^/  /'
[[ "$CHAIN_ID" == "46630" ]] && echo "note       the desk can only hold real Stock Tokens the deployer claimed from https://faucet.testnet.chain.robinhood.com"
echo "verify     Blockscout at $VERIFIER_URL"

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "== Dry run (simulation only, nothing is sent)"
  (set -a; eval "$prices"; set +a; forge script script/Deploy.s.sol --rpc-url "$RPC" --sender "$deployer")
  exit 0
fi

if [[ "${CONFIRM:-}" != "yes" ]]; then
  [[ -t 0 ]] || { echo "Not a terminal: re-run with CONFIRM=yes to broadcast"; exit 1; }
  read -r -p "Broadcast these transactions? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "Aborted"; exit 1; }
fi

(set -a; eval "$prices"; set +a
 forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --broadcast \
   --verify --verifier blockscout --verifier-url "$VERIFIER_URL")
echo "== Done. Addresses: deployments/$CHAIN_ID.json"
