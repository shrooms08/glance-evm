#!/usr/bin/env bash
# Reads live Chainlink Robinhood MAINNET prices and prints them as env assignments for script/Deploy.s.sol, which
# seeds the testnet stand-in feeds with them. Chainlink publishes no feeds on Robinhood testnet (docs/CHAIN_NOTES.md).
# NFLX has no Chainlink feed on Robinhood mainnet, so it keeps the Deploy.s.sol default unless PRICE_NFLX is set.
# On any RPC failure it prints nothing for that symbol and Deploy.s.sol falls back to its dated snapshot.
set -uo pipefail

RPC="${RH_MAINNET_RPC:-https://rpc.mainnet.chain.robinhood.com}"
FEEDS=(
  "TSLA:0x4A1166a659A55625345e9515b32adECea5547C38"
  "AMZN:0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C"
  "PLTR:0x820ABedFF239034956B7A9d2F0a331f9F075eB4c"
  "AMD:0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72"
)

fetched=()
for entry in "${FEEDS[@]}"; do
  symbol="${entry%%:*}"; feed="${entry##*:}"
  answer=$(cast call "$feed" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$RPC" 2>/dev/null \
    | sed -n '2p' | awk '{print $1}')
  if [[ "$answer" =~ ^[0-9]+$ ]] && (( answer > 0 )); then
    echo "PRICE_${symbol}=${answer}"
    fetched+=("$symbol")
  else
    echo "fetch-prices: could not read ${symbol} from ${feed}; using the snapshot default" >&2
  fi
done
if (( ${#fetched[@]} > 0 )); then
  echo "PRICE_SOURCE=\"Chainlink Robinhood mainnet feeds read $(date -u +%Y-%m-%dT%H:%MZ) for ${fetched[*]}; NFLX manual (no Chainlink feed)\""
fi
