#!/usr/bin/env bash
# Demo helper: make a stand-in feed look like the market is closed (last update 30h ago) or open (updated now).
# Usage: script/set-market.sh <robinhood|arbsepolia> <weekend|weekday> [SYMBOL|all]
set -euo pipefail
cd "$(dirname "$0")/.."
source script/networks.sh "${1:?network}"
MODE="${2:?weekend or weekday}"; SYMBOL="${3:-all}"
F="deployments/$CHAIN_ID.json"
[[ -f "$F" ]] || { echo "No $F yet: deploy first"; exit 1; }
[[ -n "${PRIVATE_KEY:-}" ]] || { echo "PRIVATE_KEY is not set"; exit 1; }
now=$(cast block latest --field timestamp --rpc-url "$RPC")
case "$MODE" in weekend) ts=$((now - 30 * 3600));; weekday) ts=$now;; *) echo "mode must be weekend or weekday"; exit 1;; esac
symbols=$([[ "$SYMBOL" == all ]] && jq -r '.stocks | to_entries[] | select(.value.skipped != true) | .key' "$F" || echo "$SYMBOL")
for s in $symbols; do
  feed=$(jq -r ".stocks.$s.feed" "$F")
  [[ "$(jq -r ".stocks.$s.feedReal" "$F")" == "true" ]] && { echo "$s uses a real feed; skipping"; continue; }
  echo "$s: setting TestPriceFeed $feed updatedAt=$ts ($MODE)"
  cast send "$feed" "setUpdatedAt(uint256)" "$ts" --private-key "$PRIVATE_KEY" --rpc-url "$RPC" > /dev/null
done
