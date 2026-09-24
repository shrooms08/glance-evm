/**
 * Links a browser session to a vault with the vault owner's key, for recording day: the deployer owns the demo vault,
 * so this does what the console's /link page does, without a wallet popup.
 *
 *   make link-demo-session SESSION=0x<the browser's session address, from Glance's settings>
 *   pnpm --filter api link-session --session 0x... [--vault 0x...] [--days 30] [--api http://localhost:8790]
 *
 * The key is read from LINK_PRIVATE_KEY, else PRIVATE_KEY (the deployer's), and is never printed or logged: only the
 * signer's address is. It signs an EIP-712 GlanceSession (a signature, never a transaction) and posts it to
 * /session/link; the API checks the signer is the vault's owner on chain.
 */
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, isAddress, type Address } from "viem";
import { MAX_SESSION_SECONDS, randomNonce, sessionTypedData } from "@glance/core/session";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const DEMO_VAULT = "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113";

async function main() {
  const session = arg("session");
  const vault = arg("vault", DEMO_VAULT)!;
  const api = arg("api", process.env.API_URL ?? "http://localhost:8790")!.replace(/\/+$/, "");
  const days = Number(arg("days", "30"));
  if (!session || !isAddress(session)) throw new Error("Pass --session 0x... (the session address shown in Glance's settings).");
  if (!isAddress(vault)) throw new Error("--vault must be a 0x address.");
  if (!(days > 0 && days <= 30)) throw new Error("--days must be between 1 and 30.");

  const envName = process.env.LINK_PRIVATE_KEY ? "LINK_PRIVATE_KEY" : "PRIVATE_KEY";
  const key = process.env[envName];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Set LINK_PRIVATE_KEY or PRIVATE_KEY (0x + 64 hex) to the vault owner's key.");
  const owner = privateKeyToAccount(key as `0x${string}`);

  const now = Math.floor(Date.now() / 1000);
  const message = {
    vault: getAddress(vault) as Address,
    sessionKey: getAddress(session) as Address,
    expiresAt: BigInt(Math.min(now + days * 86_400, now + MAX_SESSION_SECONDS - 60)),
    issuedAt: BigInt(now),
    nonce: randomNonce(256),
  };
  const typed = sessionTypedData(message);
  const signature = await owner.signTypedData(typed);
  const res = await fetch(`${api}/session/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ typedData: { domain: typed.domain, primaryType: typed.primaryType, message }, signature }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const body = (await res.json().catch(() => null)) as { error?: { message?: string }; expiresAt?: number } | null;
  if (!res.ok) throw new Error(`The API refused the link (${res.status}): ${body?.error?.message ?? "no details"}`);
  console.log(`Linked session ${message.sessionKey} to vault ${message.vault} until ${new Date(Number(message.expiresAt) * 1000).toISOString().slice(0, 10)}, signed by ${owner.address}.`);
}

main().catch((err: Error) => {
  console.error(`link-session: ${err.message}`);
  process.exit(1);
});
