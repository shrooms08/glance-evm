#!/usr/bin/env bash
# Moves the demo onto the real Paxos USDG: stocks the Paxos desk, funds the Paxos vault, and checks its configuration.
#
# Idempotent: it works towards a target state and only sends what is missing, so it is safe to re-run.
#   Paxos desk   holds STOCKS_PER_DESK (2) of each stock and DESK_USDG (40) USDG
#                (stocks come from the deployer's wallet first, then from the TestUSDG desk via its owner withdraw)
#   Paxos vault  holds VAULT_USDG (60) USDG; every stock approved with its feed; the Paxos desk approved as a router;
#                the agent set with at least AGENT_MIN_DAYS left; freshness OPEN_MAX_AGE / CLOSED_MAX_AGE
# The Paxos vault's balance falls as the agent buys, so a later run tops it back up to the target (the plan says so).
#
# Usage: script/fund-paxos.sh            (asks y/N)       CONFIRM=yes script/fund-paxos.sh   (no prompt)
#        DRY_RUN=1 script/fund-paxos.sh  (plan only, sends nothing)
#        RPC=http://127.0.0.1:8545 WRITE_DEPLOYMENT=0 ...  (rehearse against an anvil fork)
set -euo pipefail
cd "$(dirname "$0")/.."
source script/networks.sh robinhood
F="deployments/$CHAIN_ID.json"
[[ -f "$F" ]] || { echo "No $F: deploy first"; exit 1; }
[[ -n "${DRY_RUN:-}" || -n "${PRIVATE_KEY:-}" ]] || { echo "PRIVATE_KEY is not set (the deployer, owner of both desks and the Paxos vault)"; exit 1; }

STOCKS_PER_DESK="${STOCKS_PER_DESK:-2000000000000000000}" # 2 of each (18 decimals)
DESK_USDG="${DESK_USDG:-40000000}"                         # 40 USDG (6 decimals)
VAULT_USDG="${VAULT_USDG:-60000000}"                       # 60 USDG
OPEN_MAX_AGE="${OPEN_MAX_AGE:-72000}"                      # 20h
CLOSED_MAX_AGE="${CLOSED_MAX_AGE:-345600}"                 # 96h
AGENT_MIN_DAYS="${AGENT_MIN_DAYS:-7}"
AGENT_TTL_DAYS="${AGENT_TTL_DAYS:-29}"                     # the vault allows at most 30

lc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }              # macOS ships bash 3.2: no ${x,,}
num() { awk '{print $1}'; }                                  # cast prints "100000000 [1e8]"
call() { cast call "$@" --rpc-url "$RPC" | num; }
usd() { awk -v r="$1" 'BEGIN { printf "%.2f", r / 1e6 }'; }
stk() { awk -v r="$1" 'BEGIN { printf "%.4f", r / 1e18 }'; }
min() { python3 -c "print(min($1, $2))"; }
sub() { python3 -c "print(max(0, $1 - $2))"; }

USDG=$(jq -r .demoVaultPaxosUSDG.usdg "$F")
VAULT=$(jq -r .demoVaultPaxosUSDG.address "$F")
PDESK=$(jq -r .stockDeskPaxosUSDG.address "$F")
TDESK=$(jq -r .stockDesk.address "$F")
TVAULT=$(jq -r .demoVaultTestUSDG.address "$F")
TUSDG=$(jq -r .usdg.address "$F")
AGENT=$(jq -r .demoVaultPaxosUSDG.agent "$F")
DEPLOYER=$(jq -r .deployer "$F")
STOCKS=$(jq -r '.stocks | to_entries[] | select(.value.skipped != true) | "\(.key):\(.value.token):\(.value.feed)"' "$F")
if [[ -n "${PRIVATE_KEY:-}" ]]; then
  SIGNER=$(cast wallet address --private-key "$PRIVATE_KEY")
  [[ "$(lc "$SIGNER")" == "$(lc "$DEPLOYER")" ]] || { echo "PRIVATE_KEY is $SIGNER, but the desks and vault belong to $DEPLOYER"; exit 1; }
fi

# ---- read the current state ------------------------------------------------------------------------------------------
NOW=$(cast block latest --field timestamp --rpc-url "$RPC")
ETH=$(cast balance "$DEPLOYER" --ether --rpc-url "$RPC")
WALLET_USDG=$(call "$USDG" "balanceOf(address)(uint256)" "$DEPLOYER")
DESK_HAS_USDG=$(call "$PDESK" "inventory(address)(uint256)" "$USDG")
VAULT_HAS_USDG=$(call "$USDG" "balanceOf(address)(uint256)" "$VAULT")
NEED_DESK_USDG=$(sub "$DESK_USDG" "$DESK_HAS_USDG")
NEED_VAULT_USDG=$(sub "$VAULT_USDG" "$VAULT_HAS_USDG")

declare -a ACTIONS=()   # each: "description|cast send args..."
add() { ACTIONS+=("$1|$2"); }
WARN=""
CONFIG_FIXES=""

echo "== Fund the Paxos USDG demo on $NETWORK_NAME (chain $CHAIN_ID)"
echo "deployer      $DEPLOYER   $ETH ETH, $(usd "$WALLET_USDG") Paxos USDG"
echo "Paxos USDG    $USDG"
echo "Paxos desk    $PDESK"
echo "Paxos vault   $VAULT"
echo "TestUSDG desk $TDESK (stock source)"
echo
echo "-- Stocks: the Paxos desk should hold $(stk "$STOCKS_PER_DESK") of each"
for entry in $STOCKS; do
  IFS=: read -r sym token feed <<<"$entry"
  have=$(call "$PDESK" "inventory(address)(uint256)" "$token")
  need=$(sub "$STOCKS_PER_DESK" "$have")
  wallet=$(call "$token" "balanceOf(address)(uint256)" "$DEPLOYER")
  tdesk=$(call "$TDESK" "inventory(address)(uint256)" "$token")
  from_wallet=$(min "$need" "$wallet")
  from_tdesk=$(min "$(sub "$need" "$from_wallet")" "$tdesk")
  moved=$(python3 -c "print($from_wallet + $from_tdesk)")
  line=$(printf "  %-5s Paxos desk %s, needs %s" "$sym" "$(stk "$have")" "$(stk "$need")")
  if [[ "$need" == 0 ]]; then
    echo "$line  -> ok"
  else
    echo "$line  -> withdraw $(stk "$from_tdesk") from the TestUSDG desk (leaves $(stk "$(sub "$tdesk" "$from_tdesk")")), seed $(stk "$moved")"
    if [[ "$from_tdesk" != 0 ]]; then
      add "TestUSDG desk: withdraw $(stk "$from_tdesk") $sym to the deployer" "$TDESK withdraw(address,address,uint256) $token $DEPLOYER $from_tdesk"
    fi
    if [[ "$moved" != 0 ]]; then
      add "approve the Paxos desk for $(stk "$moved") $sym" "$token approve(address,uint256) $PDESK $moved"
      add "Paxos desk: seed $(stk "$moved") $sym" "$PDESK seed(address,uint256) $token $moved"
    fi
    if [[ "$moved" != "$need" ]]; then WARN+="  ! $sym: only $(stk "$moved") of the $(stk "$need") needed is available\n"; fi
  fi
  # The desk prices each stock from its feed; the vault checks the same feed.
  desk_feed=$(call "$PDESK" "feedOf(address)(address)" "$token")
  if [[ "$(lc "$desk_feed")" != "$(lc "$feed")" ]]; then
    add "Paxos desk: set the $sym feed" "$PDESK setFeed(address,address) $token $feed"; CONFIG_FIXES+="desk feed $sym, "
  fi
  read -r approved vfeed open closed < <(cast call "$VAULT" "tokenConfig(address)(bool,address,uint32,uint32)" "$token" --rpc-url "$RPC" | awk '{print $1}' | xargs)
  if [[ "$approved" != true || "$(lc "$vfeed")" != "$(lc "$feed")" ]]; then
    add "Paxos vault: approve $sym with its feed" "$VAULT setTokenApproval(address,address,bool) $token $feed true"; CONFIG_FIXES+="approval $sym, "
  fi
  if [[ "$open" != "$OPEN_MAX_AGE" || "$closed" != "$CLOSED_MAX_AGE" ]]; then
    add "Paxos vault: $sym freshness ${OPEN_MAX_AGE}s open / ${CLOSED_MAX_AGE}s closed (was ${open:-0} / ${closed:-0})" "$VAULT setTokenFreshness(address,uint32,uint32) $token $OPEN_MAX_AGE $CLOSED_MAX_AGE"; CONFIG_FIXES+="freshness $sym, "
  fi
done

echo
echo "-- USDG"
USDG_LEFT="$WALLET_USDG"
plan_usdg() { # plan_usdg <label> <need> <approve target> <call>
  local label="$1" need="$2" target="$3" fn="$4"
  if [[ "$need" == 0 ]]; then echo "  $label -> ok"; return; fi
  local amount; amount=$(min "$need" "$USDG_LEFT")
  USDG_LEFT=$(sub "$USDG_LEFT" "$amount")
  echo "  $label -> add $(usd "$amount") USDG"
  if [[ "$amount" != "$need" ]]; then WARN+="  ! $label: the deployer only has $(usd "$amount") of the $(usd "$need") USDG needed (claim more at https://faucet.paxos.com/)\n"; fi
  if [[ "$amount" != 0 ]]; then
    add "approve $(usd "$amount") USDG for $target" "$USDG approve(address,uint256) $target $amount"
    add "$fn ($(usd "$amount"))" "$5 $amount"
  fi
}
plan_usdg "Paxos desk holds $(usd "$DESK_HAS_USDG") of $(usd "$DESK_USDG") USDG (sell liquidity)" "$NEED_DESK_USDG" "$PDESK" "Paxos desk: seed the USDG" "$PDESK seed(address,uint256) $USDG"
plan_usdg "Paxos vault holds $(usd "$VAULT_HAS_USDG") of $(usd "$VAULT_USDG") USDG (tops up after buys)" "$NEED_VAULT_USDG" "$VAULT" "Paxos vault: deposit the USDG" "$VAULT deposit(uint256)"

echo
echo "-- Configuration"
if [[ -z "$CONFIG_FIXES" ]]; then
  echo "  desk feeds, token approvals with feeds, freshness ${OPEN_MAX_AGE}s / ${CLOSED_MAX_AGE}s -> ok"
else
  echo "  to fix: ${CONFIG_FIXES%, }"
fi
router=$(call "$VAULT" "approvedRouters(address)(bool)" "$PDESK")
if [[ "$router" == true ]]; then echo "  Paxos desk approved as a router -> ok"; else echo "  Paxos desk not approved as a router -> approve"; add "Paxos vault: approve the Paxos desk as a router" "$VAULT setRouterApproval(address,bool) $PDESK true"; fi
cur_agent=$(call "$VAULT" "agent()(address)")
expiry=$(call "$VAULT" "agentExpiry()(uint64)")
days_left=$(( (expiry - NOW) / 86400 ))
if [[ "$(lc "$cur_agent")" == "$(lc "$AGENT")" && $(( expiry - NOW )) -gt $(( AGENT_MIN_DAYS * 86400 )) ]]; then
  echo "  agent $AGENT, $days_left days left -> ok"
else
  new_expiry=$(( NOW + AGENT_TTL_DAYS * 86400 ))
  echo "  agent $cur_agent, $days_left days left -> set $AGENT for $AGENT_TTL_DAYS days"
  add "Paxos vault: set the agent until $(date -u -r "$new_expiry" +%Y-%m-%dT%H:%MZ 2>/dev/null || echo "$new_expiry")" "$VAULT setAgent(address,uint64) $AGENT $new_expiry"
fi

if [[ -n "$WARN" ]]; then echo; printf "%b" "$WARN"; fi

summary() {
  echo
  echo "== Summary"
  printf "  %-6s %14s %14s\n" "" "TestUSDG desk" "Paxos desk"
  for entry in $STOCKS; do
    IFS=: read -r sym token _ <<<"$entry"
    printf "  %-6s %14s %14s\n" "$sym" "$(stk "$(call "$TDESK" "inventory(address)(uint256)" "$token")")" "$(stk "$(call "$PDESK" "inventory(address)(uint256)" "$token")")"
  done
  printf "  %-6s %14s %14s\n" "USDG" "$(usd "$(call "$TDESK" "inventory(address)(uint256)" "$TUSDG")")" "$(usd "$(call "$PDESK" "inventory(address)(uint256)" "$USDG")")"
  echo
  for pair in "Paxos USDG vault (primary):$VAULT:$USDG" "TestUSDG vault (fallback):$TVAULT:$TUSDG"; do
    IFS=: read -r label v u <<<"$pair"
    read -r po bo so < <(cast call "$v" "effectiveCaps(uint8)(uint256,uint256,uint256)" 0 --rpc-url "$RPC" | awk '{print $1}' | xargs)
    read -r pc bc sc < <(cast call "$v" "effectiveCaps(uint8)(uint256,uint256,uint256)" 1 --rpc-url "$RPC" | awk '{print $1}' | xargs)
    echo "  $label $v"
    echo "    balance        $(usd "$(call "$u" "balanceOf(address)(uint256)" "$v")") USDG"
    echo "    market open    per trade \$$(usd "$po"), 24h buys \$$(usd "$bo"), 24h sells \$$(usd "$so")"
    echo "    market closed  per trade \$$(usd "$pc"), 24h buys \$$(usd "$bc"), 24h sells \$$(usd "$sc")"
  done
}

echo
if [[ ${#ACTIONS[@]} -eq 0 ]]; then
  echo "Nothing to do: the Paxos desk and vault are already at their targets."
  summary
  exit 0
fi
echo "-- ${#ACTIONS[@]} transactions"
i=0
for a in ${ACTIONS[@]+"${ACTIONS[@]}"}; do i=$((i + 1)); printf "  %2d. %s\n" "$i" "${a%%|*}"; done
if [[ -n "${DRY_RUN:-}" ]]; then echo; echo "DRY_RUN: nothing sent."; summary; exit 0; fi
if [[ "${CONFIRM:-}" != "yes" ]]; then
  [[ -t 0 ]] || { echo "Not a terminal: re-run with CONFIRM=yes"; exit 1; }
  read -r -p "Send ${#ACTIONS[@]} transactions from $DEPLOYER? [y/N] " answer
  [[ "$answer" == y || "$answer" == Y ]] || { echo "Aborted"; exit 1; }
fi

echo
i=0
for a in ${ACTIONS[@]+"${ACTIONS[@]}"}; do
  i=$((i + 1))
  desc="${a%%|*}"; args="${a#*|}"
  # shellcheck disable=SC2086
  tx=$(cast send $args --private-key "$PRIVATE_KEY" --rpc-url "$RPC" --json | jq -r '.transactionHash')
  printf "  %2d. %s\n      %s/tx/%s\n" "$i" "$desc" "$EXPLORER" "$tx"
done

# Keep the deployment record honest about the funded state (skipped when rehearsing on a fork).
if [[ "${WRITE_DEPLOYMENT:-1}" == 1 ]]; then
  bal=$(call "$USDG" "balanceOf(address)(uint256)" "$VAULT")
  tmp=$(mktemp)
  jq --argjson bal "$bal" --arg at "$(date -u +%Y-%m-%dT%H:%MZ)" \
    '.demoVaultPaxosUSDG.usdgBalance = $bal | .demoVaultPaxosUSDG.fundedAt = $at' "$F" >"$tmp" && mv "$tmp" "$F"
  echo "  updated $F (Paxos vault balance, fundedAt)"
fi
summary
