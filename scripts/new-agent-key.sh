#!/usr/bin/env bash
# Makes a new Glance agent key (for rotating the API's AGENT_PRIVATE_KEY).
#
#   bash scripts/new-agent-key.sh <file>
#
# Generates a random private key (viem's generatePrivateKey, from the API's own dependencies), writes it to <file> as
# "AGENT_PRIVATE_KEY=0x..." with permissions 600, and prints only the new agent address. The key is never printed,
# never passed as a command argument, and never written anywhere else. It refuses to overwrite an existing file, and
# refuses a path inside this repository unless git ignores it.
#
# Then: put the file's value into Railway's AGENT_PRIVATE_KEY, send the new address a little testnet ETH for gas, and
# approve it on each vault from the console's Limits page ("Approve new Glance agent").
set -euo pipefail
set +x

if [ $# -ne 1 ]; then
  echo "usage: bash scripts/new-agent-key.sh <file to write the key to>" >&2
  exit 2
fi
out="$1"
root="$(cd "$(dirname "$0")/.." && pwd)"

if [ -e "$out" ]; then
  echo "$out already exists: choose a new file (nothing was written)." >&2
  exit 1
fi
dir="$(cd "$(dirname "$out")" 2>/dev/null && pwd)" || {
  echo "The folder for $out doesn't exist (nothing was written)." >&2
  exit 1
}
abs="$dir/$(basename "$out")"
case "$abs" in
  "$root"/*)
    if ! git -C "$root" check-ignore -q "$abs"; then
      echo "$abs is inside the repository and not ignored by git: choose a path outside it (nothing was written)." >&2
      exit 1
    fi
    ;;
esac

# The key is made and written inside node: only the address comes back out.
cd "$root/apps/api"
GLANCE_KEY_FILE="$abs" node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
  const key = generatePrivateKey();
  writeFileSync(process.env.GLANCE_KEY_FILE, `AGENT_PRIVATE_KEY=${key}\n`, { mode: 0o600, flag: "wx" });
  console.log(privateKeyToAccount(key).address);
' | {
  read -r address
  echo "New agent address: $address"
  echo "Key written to $abs (permissions 600). It was not printed."
}
