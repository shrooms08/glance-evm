#!/usr/bin/env bash
# Checks that a redeploy keeps every key script/Deploy.s.sol doesn't own. Runs by `make test`; jq only, no network.
# The "existing" record is the real deployments/46630.json plus the ETF stand-ins and an unknown key; the "output" is
# what Deploy.s.sol writes (its own keys only, a changed desk address, and no factoryV2).
set -euo pipefail
cd "$(dirname "$0")/.."
dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
fail() { echo "merge-deployment: FAIL: $1"; exit 1; }

jq '.stocks.SPY = {skipped: false, etfStandIn: true, token: "0x5d7bEAe66da99B88Aa1ACE7C49F72e5AFBd59c02"}
    | .stocks.QQQ = {skipped: false, etfStandIn: true, token: "0x1f2676a6f87c516e48f32DD73bE44E910E66350c"}
    | .faucetInfo = {note: "added by hand"}' deployments/46630.json > "$dir/existing.json"
jq 'del(.factoryV2) | .stockDesk.address = "0x0000000000000000000000000000000000000001"
    | .stocks = (.stocks | with_entries(select(.key != "SPY" and .key != "QQQ")))
    | .stocks.TSLA.price = 1' deployments/46630.json > "$dir/output.json"

line=$(script/merge-deployment.sh "$dir/existing.json" "$dir/output.json" "$dir/merged.json")
m="$dir/merged.json"
[[ "$(jq -r .factoryV2.address "$m")" == "$(jq -r .factoryV2.address deployments/46630.json)" ]] || fail "factoryV2 dropped"
[[ "$(jq -r .stocks.SPY.token "$m")" == "0x5d7bEAe66da99B88Aa1ACE7C49F72e5AFBd59c02" ]] || fail "stocks.SPY dropped"
[[ "$(jq -r .stocks.QQQ.etfStandIn "$m")" == "true" ]] || fail "stocks.QQQ dropped"
[[ "$(jq -r .faucetInfo.note "$m")" == "added by hand" ]] || fail "an unknown key was dropped"
[[ "$(jq -r .stockDesk.address "$m")" == "0x0000000000000000000000000000000000000001" ]] || fail "an owned key wasn't replaced"
[[ "$(jq -r .stocks.TSLA.price "$m")" == "1" ]] || fail "an owned stock wasn't replaced"
[[ "$(jq -r '.stocks | keys | length' "$m")" == "$(( $(jq -r '.stocks | keys | length' deployments/46630.json) + 2 ))" ]] || fail "stock count"
[[ "$line" == "kept from the existing record: factoryV2, faucetInfo, stocks.QQQ, stocks.SPY" ]] || fail "report: $line"
echo "merge-deployment: ok (a redeploy keeps factoryV2, stocks.SPY, stocks.QQQ and unknown keys; owned keys are replaced)"
