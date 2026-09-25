/**
 * NEXT_PUBLIC_* variables are inlined into the JavaScript every visitor downloads. This check stops a build (it runs
 * from next.config.ts) that would ship a secret: an RPC URL with a key in it (a QuickNode or Alchemy token path, an
 * Infura project id, a key or token query parameter, user:password), or any public variable named like a secret.
 * It names the variable, never its value. The console needs no secret: leave NEXT_PUBLIC_RPC_URL unset (the public
 * Robinhood Chain RPC) or use an endpoint made for browsers.
 */

/** Public by design (WalletConnect project ids are meant to be in the page). */
const ALLOWED_NAMES = new Set(["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"]);

function urlCarriesKey(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.username || u.password) return true;
  const host = u.hostname.toLowerCase();
  const segments = u.pathname.split("/").filter(Boolean);
  if (host.endsWith("quiknode.pro") && segments.some((s) => s.length >= 16)) return true;
  if (/alchemy(api)?\.(com|io)$/.test(host) && segments.some((s) => s.length >= 16)) return true;
  if (host.endsWith("infura.io") && segments.some((s) => /^[0-9a-f]{32}$/i.test(s))) return true;
  for (const k of u.searchParams.keys()) if (/^(api[-_]?key|key|token|access[-_]?token|secret)$/i.test(k)) return true;
  return false;
}

/** The public variables that would leak a secret, and why (names only). Empty: safe to build. */
export function publicEnvProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("NEXT_PUBLIC_") || !value) continue;
    if (/RPC/.test(name) && value.split(",").some(urlCarriesKey)) problems.push(`${name} contains an RPC URL with a key in it`);
    else if (!ALLOWED_NAMES.has(name) && /(KEY|SECRET|TOKEN|PRIVATE|PASSWORD)/.test(name)) problems.push(`${name} is named like a secret`);
  }
  return problems;
}

/** Throws (stopping the build) if any public variable would ship a secret. */
export function assertPublicEnvSafe(env: Record<string, string | undefined> = process.env) {
  const problems = publicEnvProblems(env);
  if (problems.length) {
    throw new Error(
      `Refusing to build: NEXT_PUBLIC_* variables go to every visitor's browser.\n  ${problems.join("\n  ")}\n` +
        "Leave NEXT_PUBLIC_RPC_URL unset (the public Robinhood Chain RPC is used) or use an endpoint made for browsers.",
    );
  }
}
