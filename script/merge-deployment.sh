#!/usr/bin/env bash
# Merges what script/Deploy.s.sol wrote (only the keys it owns) into an existing deployment record, keeping every key the
# deploy script doesn't own: factoryV2 (script/deploy-factory-v2.sh), the ETF stand-ins under stocks.* (script/deploy-
# etf-standins.sh), and anything added later. A key the deploy script owns replaces the old value whole; stocks are
# merged per symbol. Prints what was kept, so a redeploy can't drop something silently.
# Usage: script/merge-deployment.sh <existing record> <deploy output> <out file>   (out may be the existing record)
set -euo pipefail
existing="${1:?existing record}"; output="${2:?deploy output}"; out="${3:?out file}"
tmp=$(mktemp)
jq -n --slurpfile old "$existing" --slurpfile new "$output" \
  '($old[0] // {}) as $o | $new[0] as $n | ($o + $n) | .stocks = (($o.stocks // {}) + ($n.stocks // {}))' > "$tmp"
kept=$(jq -rn --slurpfile old "$existing" --slurpfile new "$output" \
  '($old[0] // {}) as $o | $new[0] as $n
   | ([$o | keys[] as $k | select(($n | has($k)) | not) | $k]
      + [($o.stocks // {}) | keys[] as $k | select((($n.stocks // {}) | has($k)) | not) | "stocks.\($k)"]) | join(", ")')
mv "$tmp" "$out"
echo "kept from the existing record: ${kept:-<nothing extra>}"
