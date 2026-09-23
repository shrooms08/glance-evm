#!/usr/bin/env bash
# Prints forge verify-contract commands for everything in deployments/<chainid>.json. Use it if verification during
# deploy failed or was skipped. Usage: script/verify-commands.sh <robinhood|arbsepolia>
set -euo pipefail
cd "$(dirname "$0")/.."
source script/networks.sh "${1:?usage: script/verify-commands.sh <robinhood|arbsepolia>}"
F="deployments/$CHAIN_ID.json"
[[ -f "$F" ]] || { echo "No $F yet: deploy first"; exit 1; }

common="--chain $CHAIN_ID --verifier blockscout --verifier-url $VERIFIER_URL --rpc-url $RPC --watch"
guess="--guess-constructor-args"
owner=$(jq -r .demoVaultTestUSDG.owner "$F"); usdg=$(jq -r .usdg.address "$F")

echo "# Glance contracts on $NETWORK_NAME ($EXPLORER)"
echo "forge verify-contract $(jq -r .factory.address "$F") src/GlanceVaultFactory.sol:GlanceVaultFactory $common"
echo "forge verify-contract $(jq -r .stockDesk.address "$F") src/testnet/StockDesk.sol:StockDesk $common $guess"
# The vault is created inside the factory, so its constructor args cannot be guessed from a transaction.
echo "forge verify-contract $(jq -r .demoVaultTestUSDG.address "$F") src/GlanceVault.sol:GlanceVault $common --constructor-args \$(cast abi-encode 'c(address,address)' $owner $usdg)"
if [[ "$(jq -r '.demoVaultPaxosUSDG // empty' "$F")" != "" ]]; then
  # Deployed directly by the script, so its constructor args can be guessed from the creation transaction.
  echo "forge verify-contract $(jq -r .demoVaultPaxosUSDG.address "$F") src/GlanceVault.sol:GlanceVault $common $guess"
  echo "forge verify-contract $(jq -r .stockDeskPaxosUSDG.address "$F") src/testnet/StockDesk.sol:StockDesk $common $guess"
fi
if [[ "$(jq -r .usdg.real "$F")" == "false" ]]; then
  echo "forge verify-contract $usdg src/testnet/TestUSDG.sol:TestUSDG $common $guess"
fi
for s in $(jq -r '.stocks | to_entries[] | select(.value.skipped != true) | .key' "$F"); do
  [[ "$(jq -r ".stocks.$s.tokenReal" "$F")" == "false" ]] && \
    echo "forge verify-contract $(jq -r ".stocks.$s.token" "$F") src/testnet/TestStockToken.sol:TestStockToken $common $guess"
  [[ "$(jq -r ".stocks.$s.feedReal" "$F")" == "false" ]] && \
    echo "forge verify-contract $(jq -r ".stocks.$s.feed" "$F") src/testnet/TestPriceFeed.sol:TestPriceFeed $common $guess"
done
