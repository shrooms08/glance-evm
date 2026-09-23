#!/usr/bin/env bash
# Sets the oracle freshness thresholds (openMaxAge, closedMaxAge, in seconds) for every listed stock on the demo vaults.
# Sends owner transactions, so it asks first. Usage: script/set-freshness.sh <robinhood|arbsepolia> <open> <closed>
set -euo pipefail
cd "$(dirname "$0")/.."
source script/networks.sh "${1:?network}"
OPEN="${2:?openMaxAge seconds}"; CLOSED="${3:?closedMaxAge seconds}"
F="deployments/$CHAIN_ID.json"
[[ -f "$F" ]] || { echo "No $F yet: deploy first"; exit 1; }
[[ -n "${PRIVATE_KEY:-}" ]] || { echo "PRIVATE_KEY is not set"; exit 1; }
vaults=$(jq -r '[.demoVaultTestUSDG.address, (.demoVaultPaxosUSDG.address // empty)] | .[]' "$F")
tokens=$(jq -r '.stocks | to_entries[] | select(.value.skipped != true) | "\(.key):\(.value.token)"' "$F")

echo "== About to set price freshness on $NETWORK_NAME: OPEN up to ${OPEN}s ($((OPEN / 3600))h), CLOSED up to ${CLOSED}s ($((CLOSED / 3600))h)"
echo "vaults: $(echo $vaults)"
echo "tokens: $(echo "$tokens" | cut -d: -f1 | tr '\n' ' ')"
if [[ "${CONFIRM:-}" != "yes" ]]; then
  [[ -t 0 ]] || { echo "Not a terminal: re-run with CONFIRM=yes"; exit 1; }
  read -r -p "Send $(( $(echo "$vaults" | wc -l) * $(echo "$tokens" | wc -l) )) transactions? [y/N] " answer
  [[ "$answer" == y || "$answer" == Y ]] || { echo "Aborted"; exit 1; }
fi
for v in $vaults; do
  for entry in $tokens; do
    symbol="${entry%%:*}"; token="${entry##*:}"
    cast send "$v" "setTokenFreshness(address,uint32,uint32)" "$token" "$OPEN" "$CLOSED" \
      --private-key "$PRIVATE_KEY" --rpc-url "$RPC" > /dev/null
    echo "  $v $symbol: open ${OPEN}s, closed ${CLOSED}s"
  done
done
