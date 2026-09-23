#!/usr/bin/env bash
# Deploys GlanceVaultFactoryV2 alone, verifies it on Blockscout, and records it as `factoryV2` in the deployment
# record (the original `factory` entry is kept). Usage: script/deploy-factory-v2.sh <network> [--dry-run]
# The dry run simulates against the live chain and sends nothing; it needs no private key.
set -euo pipefail
cd "$(dirname "$0")/.."
source script/networks.sh "${1:?usage: script/deploy-factory-v2.sh <robinhood|arbsepolia> [--dry-run]}"
DRY_RUN="${2:-}"
RECORD="deployments/$CHAIN_ID.json"

actual=$(cast chain-id --rpc-url "$RPC")
[[ "$actual" == "$CHAIN_ID" ]] || { echo "RPC reports chain $actual, expected $CHAIN_ID"; exit 1; }

if [[ -n "${PRIVATE_KEY:-}" ]]; then
  deployer=$(cast wallet address --private-key "$PRIVATE_KEY")
elif [[ -f "$RECORD" ]]; then
  deployer=$(jq -r '.deployer' "$RECORD")
else
  deployer=""
fi

echo "== GlanceVaultFactoryV2 on $NETWORK_NAME (chain $CHAIN_ID)"
echo "deployer   ${deployer:-<unknown>}${deployer:+   balance $(cast balance "$deployer" --ether --rpc-url "$RPC") ETH}"
if [[ -f "$RECORD" ]]; then
  echo "factory    $(jq -r '.factory.address' "$RECORD") (kept, untouched)"
  echo "factoryV2  $(jq -r '.factoryV2.address // "<none yet>"' "$RECORD")"
fi

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  [[ -n "$deployer" ]] || { echo "No deployer: set PRIVATE_KEY in .env, or have a deployment record with a deployer"; exit 1; }
  echo "== Dry run (simulation only, nothing is sent)"
  forge script script/DeployFactoryV2.s.sol --rpc-url "$RPC" --sender "$deployer"
  exit 0
fi

[[ -n "${PRIVATE_KEY:-}" ]] || { echo "PRIVATE_KEY is not set (copy .env.example to .env)"; exit 1; }
if [[ "${CONFIRM:-}" != "yes" ]]; then
  [[ -t 0 ]] || { echo "Not a terminal: re-run with CONFIRM=yes to broadcast"; exit 1; }
  read -r -p "Deploy GlanceVaultFactoryV2 from $deployer? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "Aborted"; exit 1; }
fi

forge script script/DeployFactoryV2.s.sol --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --broadcast \
  --verify --verifier blockscout --verifier-url "$VERIFIER_URL"

address=$(jq -r '[.transactions[] | select(.contractName == "GlanceVaultFactoryV2" and .transactionType == "CREATE")][0].contractAddress' \
  "broadcast/DeployFactoryV2.s.sol/$CHAIN_ID/run-latest.json")
[[ "$address" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "Couldn't read the deployed address from the broadcast record"; exit 1; }
address=$(cast to-check-sum-address "$address")
[[ -n "$(cast code "$address" --rpc-url "$RPC" | sed 's/^0x$//')" ]] || { echo "No code at $address yet"; exit 1; }

if [[ -f "$RECORD" ]]; then
  tmp=$(mktemp)
  jq --arg a "$address" --arg at "$(date -u +%Y-%m-%dT%H:%MZ)" \
    '.factoryV2 = {address: $a, kind: "glance-v2", note: "One-transaction vaults: createVaultWithConfig(config, deposit). The original factory stays in .factory.", deployedAt: $at}' \
    "$RECORD" > "$tmp" && mv "$tmp" "$RECORD"
  echo "== Recorded factoryV2 = $address in $RECORD"
fi
echo "== Done: $EXPLORER/address/$address"
