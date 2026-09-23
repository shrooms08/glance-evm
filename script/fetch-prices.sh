#!/usr/bin/env bash
# Prints env assignments for script/Deploy.s.sol: the price each testnet stand-in feed is seeded with, and where it
# came from. Chainlink publishes no feeds on Robinhood Chain testnet (docs/CHAIN_NOTES.md), so:
#   TSLA, AMZN, PLTR, AMD  live reads of the real Chainlink feeds on Robinhood MAINNET  -> source "chainlink-live: ..."
#   NFLX                   no Chainlink feed anywhere: a free public quote (Yahoo Finance, then Nasdaq)
#                          -> source "public-quote: ..."
# A symbol that cannot be fetched prints nothing. Deploy.s.sol then uses PRICE_<SYMBOL> from .env if set (recorded as
# "env"), else its dated snapshot, and skips NFLX entirely rather than seed a wrong price.
set -uo pipefail

RPC="${RH_MAINNET_RPC:-https://rpc.mainnet.chain.robinhood.com}"
UA="Mozilla/5.0 (glance-evm deploy script)"
# Mainnet feed addresses live in one place: config/price-sources.json (shared with apps/keeper and apps/api).
SOURCES="$(dirname "$0")/../config/price-sources.json"
# Entries look like SYMBOL:0xaddress (no spaces), so plain word splitting works, even on macOS's bash 3.2.
FEEDS=($(jq -r '.sources | to_entries[] | select(.value.kind == "mainnet-mirror") | "\(.key):\(.value.feed)"' "$SOURCES"))

# Decimal dollar string -> 8-decimal integer, or empty if not a positive number.
to_8dp() { awk -v p="$1" 'BEGIN { if (p ~ /^[0-9]+(\.[0-9]+)?$/ && p + 0 > 0) printf "%.0f", p * 1e8 }'; }
iso() { date -u -r "$1" +%Y-%m-%dT%H:%MZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%MZ; }

echo "PRICES_FETCHED_AT=\"$(date -u +%Y-%m-%dT%H:%MZ)\""

for entry in "${FEEDS[@]}"; do
  symbol="${entry%%:*}"; feed="${entry##*:}"
  round=$(cast call "$feed" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$RPC" 2>/dev/null)
  answer=$(echo "$round" | sed -n '2p' | awk '{print $1}')
  updated=$(echo "$round" | sed -n '4p' | awk '{print $1}')
  if [[ "$answer" =~ ^[0-9]+$ ]] && (( answer > 0 )); then
    echo "PRICE_${symbol}=${answer}"
    echo "PRICE_SOURCE_${symbol}=\"chainlink-live: Robinhood mainnet feed ${feed}, updated $(iso "$updated")\""
  else
    echo "fetch-prices: could not read ${symbol} from Chainlink ${feed}" >&2
  fi
done

# NFLX: public quote. Yahoo Finance first, Nasdaq second.
nflx=""; nflx_source=""
if json=$(curl -sS -m 15 -A "$UA" "https://query1.finance.yahoo.com/v8/finance/chart/NFLX?interval=1d&range=1d" 2>/dev/null); then
  px=$(echo "$json" | jq -r '.chart.result[0].meta.regularMarketPrice // empty' 2>/dev/null)
  at=$(echo "$json" | jq -r '.chart.result[0].meta.regularMarketTime // empty' 2>/dev/null)
  nflx=$(to_8dp "$px")
  [[ -n "$nflx" ]] && nflx_source="public-quote: Yahoo Finance NFLX regularMarketPrice USD ${px} at $(iso "$at")"
fi
if [[ -z "$nflx" ]]; then
  if json=$(curl -sS -m 15 -A "$UA" -H "Accept: application/json" "https://api.nasdaq.com/api/quote/NFLX/info?assetclass=stocks" 2>/dev/null); then
    px=$(echo "$json" | jq -r '.data.primaryData.lastSalePrice // empty' 2>/dev/null | tr -d '$,')
    at=$(echo "$json" | jq -r '.data.primaryData.lastTradeTimestamp // empty' 2>/dev/null)
    nflx=$(to_8dp "$px")
    [[ -n "$nflx" ]] && nflx_source="public-quote: Nasdaq NFLX lastSalePrice USD ${px} (${at})"
  fi
fi
if [[ -n "$nflx" ]]; then
  echo "PRICE_NFLX=${nflx}"
  echo "PRICE_SOURCE_NFLX=\"${nflx_source}\""
else
  echo "fetch-prices: no public NFLX quote; Deploy.s.sol will use PRICE_NFLX from .env or skip NFLX" >&2
fi
