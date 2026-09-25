#!/usr/bin/env bash
# Checks whether any value from your local .env files ever made it into this repository's git history.
#
# Reads apps/api/.env, apps/console/.env* (not *.example), apps/keeper/.env and the root .env, if present. For every
# variable with a value of 12 characters or more, it searches every revision's files (git grep over git rev-list --all)
# and every diff and commit message (git log --all -p) for that exact value, and for a QuickNode URL also for its token
# path alone. It prints variable names and where they were found, never a value (not even part of one): values go
# only into a private temporary file, never into command arguments or output.
#
#   bash scripts/leak-check.sh        exit 0: nothing found; exit 1: something was found
set -euo pipefail
set +x

cd "$(git rev-parse --show-toplevel)"

files=()
for f in apps/api/.env apps/console/.env apps/console/.env.* apps/keeper/.env .env; do
  [ -f "$f" ] || continue
  case "$f" in *.example | *.sample | *.template) continue ;; esac
  files+=("$f")
done
if [ ${#files[@]} -eq 0 ]; then
  echo "No .env files found: nothing to check."
  exit 0
fi

work="$(mktemp -d)"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
pattern="$work/pattern"

revs="$work/revs"
git rev-list --all >"$revs"

found_any=0

# Where one value (in $pattern) appears: "commit path", or nothing. Values are read from the file, never passed as
# arguments, and git's own errors are discarded so nothing about the value can be echoed.
where_in_history() {
  local hit
  # Every revision's files.
  hit="$(xargs git grep -l -F -f "$pattern" <"$revs" 2>/dev/null | head -n 1 || true)"
  if [ -n "$hit" ]; then
    local rev="${hit%%:*}" path="${hit#*:}"
    echo "commit $(git rev-parse --short "$rev" 2>/dev/null), path $path"
    return
  fi
  # Every diff (removed lines included) and commit message.
  hit="$(git log --all -p --format='@@@commit %h%n%B' 2>/dev/null | awk -v pf="$pattern" '
    BEGIN { getline pat < pf; close(pf) }
    /^@@@commit / { c = $2; p = "(commit message)"; next }
    /^diff --git / { p = $4; sub(/^b\//, "", p); next }
    index($0, pat) { print "commit " c ", path " p; exit }
  ' || true)"
  [ -n "$hit" ] && echo "$hit"
  return 0
}

check() {
  local label="$1" hint="$2"
  local hit
  hit="$(where_in_history)"
  if [ -n "$hit" ]; then
    echo "$label: FOUND in history ($hit)$hint"
    found_any=1
  else
    echo "$label: not in history"
  fi
}

for f in "${files[@]}"; do
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in '' | '#'*) continue ;; esac
    line="${line#export }"
    case "$line" in *=*) ;; *) continue ;; esac
    name="${line%%=*}"
    value="${line#*=}"
    name="${name%"${name##*[![:space:]]}"}"
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # Quoted values keep everything inside the quotes; unquoted ones end at " #" (a trailing comment).
    if [[ "$value" == \"*\" && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    else
      value="${value%% #*}"
      value="${value%"${value##*[![:space:]]}"}"
    fi
    [ ${#value} -ge 12 ] || continue

    # A setting rather than a secret (a model name, a path) shows up in the code as well: said so, still counted.
    hint=""
    [[ "$name" =~ (KEY|SECRET|TOKEN|PASSWORD|PRIVATE|URL|DSN|AUTH) ]] || hint=" [name doesn't look like a secret: probably a setting]"

    printf '%s\n' "$value" >"$pattern"
    check "$name ($f)" "$hint"

    # A QuickNode URL: its token path on its own too (it may have been committed without the host).
    if [[ "$value" =~ ^https?://[^/]*quiknode\.pro/([^/?#]+) ]]; then
      token="${BASH_REMATCH[1]}"
      if [ ${#token} -ge 12 ]; then
        printf '%s\n' "$token" >"$pattern"
        check "$name ($f) token path" ""
      fi
    fi
    : >"$pattern"
  done <"$f"
done

value=""
token=""
if [ "$found_any" -eq 0 ]; then
  echo "Nothing from the .env files is in git history."
  exit 0
fi
echo "Something above is in git history: rotate those keys, and treat the repository as exposed."
exit 1
