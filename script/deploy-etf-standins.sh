#!/usr/bin/env bash
# ETF stand-ins (SPY, QQQ) on Robinhood Chain testnet: a TestStockToken and a TestPriceFeed each, seeded from the live
# Chainlink feeds on Robinhood Chain MAINNET (price and updatedAt), listed and stocked on both desks. Records them under
# .stocks.SPY and .stocks.QQQ in deployments/46630.json, only after a real broadcast.
# Usage: script/deploy-etf-standins.sh [--dry-run]
# The dry run simulates against the live chain and sends nothing; it needs no private key (it acts as the recorded deployer).
set -euo pipefail
cd "$(dirname "$0")/.."
source script/networks.sh robinhood
DRY_RUN="${1:-}"
RECORD="deployments/$CHAIN_ID.json"
MAINNET_RPC="${RH_MAINNET_RPC:-https://rpc.mainnet.chain.robinhood.com}"
[[ -f "$RECORD" ]] || { echo "No $RECORD: run make deploy-robinhood first"; exit 1; }

actual=$(cast chain-id --rpc-url "$RPC")
[[ "$actual" == "$CHAIN_ID" ]] || { echo "RPC reports chain $actual, expected $CHAIN_ID"; exit 1; }
[[ "$(cast chain-id --rpc-url "$MAINNET_RPC")" == "4663" ]] || { echo "$MAINNET_RPC is not Robinhood Chain mainnet (4663)"; exit 1; }
deployer=$(jq -r '.deployer' "$RECORD")

iso() { date -u -r "$1" +%Y-%m-%dT%H:%MZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%MZ; }
# The mainnet feeds, from config/price-sources.json (the keeper mirrors the same ones afterwards).
for symbol in SPY QQQ; do
  feed=$(jq -r --arg s "$symbol" '.sources[$s] | select(.kind == "mainnet-mirror") | .feed' config/price-sources.json)
  [[ "$feed" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "config/price-sources.json has no mainnet feed for $symbol"; exit 1; }
  round=$(cast call "$feed" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$MAINNET_RPC")
  answer=$(echo "$round" | sed -n '2p' | awk '{print $1}')
  updated=$(echo "$round" | sed -n '4p' | awk '{print $1}')
  [[ "$answer" =~ ^[0-9]+$ && "$answer" -gt 0 ]] || { echo "Couldn't read $symbol from Chainlink $feed on mainnet"; exit 1; }
  export "PRICE_$symbol=$answer" "PRICE_UPDATED_$symbol=$updated"
  export "PRICE_SOURCE_$symbol=chainlink-live: Robinhood mainnet feed $feed, updated $(iso "$updated")"
done

echo "== ETF stand-ins on $NETWORK_NAME (chain $CHAIN_ID)"
echo "deployer   $deployer   balance $(cast balance "$deployer" --ether --rpc-url "$RPC") ETH"
for symbol in SPY QQQ; do
  p="PRICE_$symbol"; u="PRICE_UPDATED_$symbol"
  echo "$symbol        \$$(awk -v r="${!p}" 'BEGIN { printf "%.2f", r / 1e8 }') from mainnet Chainlink, updated $(iso "${!u}");" \
    "recorded: $(jq -r --arg s "$symbol" '.stocks[$s].token // "<not deployed yet>"' "$RECORD")"
done
echo "desks      $(jq -r '.stockDeskPaxosUSDG.address' "$RECORD") (Paxos USDG), $(jq -r '.stockDesk.address' "$RECORD") (TestUSDG)"
echo "untouched  every vault and factory (vaults opt in from the console's Limits page)"

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "== Dry run (simulation only, nothing is sent)"
  forge script script/DeployEtfStandIns.s.sol --rpc-url "$RPC" --sender "$deployer"
  exit 0
fi

[[ -n "${PRIVATE_KEY:-}" ]] || { echo "PRIVATE_KEY is not set (the deployer: it owns both desks)"; exit 1; }
[[ "$(cast wallet address --private-key "$PRIVATE_KEY" | tr '[:upper:]' '[:lower:]')" == "$(echo "$deployer" | tr '[:upper:]' '[:lower:]')" ]] ||
  { echo "PRIVATE_KEY isn't the recorded deployer $deployer"; exit 1; }
if [[ "${CONFIRM:-}" != "yes" ]]; then
  [[ -t 0 ]] || { echo "Not a terminal: re-run with CONFIRM=yes to broadcast"; exit 1; }
  read -r -p "Deploy the SPY and QQQ stand-ins from $deployer? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "Aborted"; exit 1; }
fi

forge script script/DeployEtfStandIns.s.sol --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --broadcast \
  --verify --verifier blockscout --verifier-url "$VERIFIER_URL"

OUT="deployments/$CHAIN_ID.etf-standins.json"
[[ -f "$OUT" ]] || { echo "The script didn't write $OUT"; exit 1; }
tmp=$(mktemp)
jq --slurpfile etfs "$OUT" '.stocks += $etfs[0]' "$RECORD" > "$tmp" && mv "$tmp" "$RECORD" && rm "$OUT"
echo "== Recorded .stocks.SPY and .stocks.QQQ in $RECORD. Next: make keeper (mirrors their feeds from now on)."
