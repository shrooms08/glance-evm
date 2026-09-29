/**
 * The extension for production, pointed at the hosted Glance:
 *
 *   API_URL=https://<api>.up.railway.app CONSOLE_URL=https://<console>.vercel.app pnpm --filter extension build:prod
 *
 * Bakes both in (WXT_API_URL, WXT_CONSOLE_URL; the console's origin also becomes WXT_CONSOLE_ORIGINS, so its pages get
 * the handshake), builds into .output-prod (never the .output you load for development), and zips it:
 * .output-prod/glance-extension-<version>.zip. The manifest's fixed public key keeps the extension ID the same
 * (gmcdcaoneeohbacbnafjdnkkoojgnogl), so the API's CORS_ORIGINS stays right: the ID is computed from the built
 * manifest and checked.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const here = resolve(import.meta.dirname, "..");
const OUT = ".output-prod";
export const EXTENSION_ID = "gmcdcaoneeohbacbnafjdnkkoojgnogl";

/** Chrome's extension ID for a manifest key: the SHA-256 of the public key, first 32 hex digits written as a-p. */
export function extensionIdFor(key: string): string {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/** An https origin (a path is allowed for the API, not for the console), or a clear error. Never a localhost. */
export function productionUrl(name: string, value: string | undefined, allowPath: boolean): string {
  if (!value?.trim()) throw new Error(`${name} is required, e.g. ${name}=https://${name === "API_URL" ? "glance-api.up.railway.app" : "glance-console.vercel.app"}`);
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new Error(`${name} isn't a URL`);
  }
  if (u.protocol !== "https:") throw new Error(`${name} must be https:// (a production build)`);
  if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) throw new Error(`${name} points at localhost: use pnpm --filter extension build for development`);
  if (u.username || u.password || u.search) throw new Error(`${name} must be a plain address (no credentials or query)`);
  if (!allowPath && u.pathname !== "/") throw new Error(`${name} must be an origin like https://glance-console.vercel.app (no path)`);
  return allowPath ? u.href.replace(/\/+$/, "") : u.origin;
}

function run(args: string[], env: Record<string, string>) {
  const r = spawnSync("pnpm", ["exec", "wxt", ...args], { cwd: here, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`wxt ${args.join(" ")} failed`);
}

/** Builds and zips the production extension; returns the zip's path and the version. Throws with a clear message. */
export function buildProd(apiUrl: string | undefined, consoleUrlValue: string | undefined): { zip: string; version: string } {
  const api = productionUrl("API_URL", apiUrl, true);
  const consoleUrl = productionUrl("CONSOLE_URL", consoleUrlValue, false);
  // The real-site test's all-sites permission is never shipped: forced off here, whatever the shell has set.
  const env = { WXT_API_URL: api, WXT_CONSOLE_URL: consoleUrl, WXT_CONSOLE_ORIGINS: consoleUrl, WXT_OUT_DIR: OUT, WXT_E2E_ALL_SITES: "" };
  console.log(`build:prod: API ${api}, console ${consoleUrl}`);
  run(["build"], env);
  run(["zip"], env);
  const manifest = JSON.parse(readFileSync(resolve(here, OUT, "chrome-mv3/manifest.json"), "utf8")) as { key?: string; version: string };
  const zip = readdirSync(resolve(here, OUT)).find((f) => f === `glance-extension-${manifest.version}.zip`);
  if (!manifest.key || extensionIdFor(manifest.key) !== EXTENSION_ID) throw new Error("the built manifest's key doesn't give the fixed extension ID");
  if ((manifest as { host_permissions?: string[] }).host_permissions?.includes("<all_urls>")) throw new Error("the build asks for every site up front (a test-only setting)");
  if (!zip || !existsSync(resolve(here, OUT, zip))) throw new Error("the zip wasn't written");
  console.log(`build:prod: extension ID ${EXTENSION_ID} (the fixed key, checked)`);
  return { zip: resolve(here, OUT, zip), version: manifest.version };
}

if (process.argv[1]?.endsWith("build-prod.ts")) {
  try {
    console.log(`build:prod: ${buildProd(process.env.API_URL, process.env.CONSOLE_URL).zip}`);
  } catch (err) {
    console.error(`build:prod: ${(err as Error).message}`);
    process.exit(1);
  }
}
