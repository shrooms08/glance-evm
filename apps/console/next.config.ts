import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

import { assertPublicEnvSafe } from "./publicEnvGuard";
import { DASHBOARD_REDIRECTS } from "./lib/routes";

// Nothing secret may reach the browser bundle (an RPC URL with a key, a variable named like a secret).
assertPublicEnvSafe();

const here = dirname(fileURLToPath(import.meta.url));

export const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const config: NextConfig = {
  // The shared packages ship TypeScript source.
  transpilePackages: ["@glance/design", "@glance/core"],
  // The monorepo root: deployments/46630.json and packages/* live above this app.
  turbopack: { root: resolve(here, "../..") },
  outputFileTracingRoot: resolve(here, "../.."),
  // Wallet SDKs under wagmi's Base Account connector lazily import x402 payment modules that aren't installed and
  // that the console never calls. Left to Node on the server (never bundled), those imports never run.
  serverExternalPackages: ["@base-org/account", "@coinbase/cdp-sdk"],
  reactStrictMode: true,
  // The end-to-end check builds into its own folder, so it never touches a running dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  // "/" is the public landing page. The Dashboard lives at /dashboard; the URLs that used to open it at "/" (the
  // extension's link handshake "/?glance=link&vault=...", a vault picked with "?vault=...", developer mode "?dev=1")
  // still land there, query and all. See lib/routes.ts and test/routes.test.ts.
  redirects: async () => DASHBOARD_REDIRECTS,
  // Security headers on every route (docs/audit.md L-13): the console's signing pages can't be framed (clickjacking),
  // referrers leave only the origin cross-site, and responses aren't type-sniffed. frame-ancestors is the only CSP
  // directive on purpose: a fuller policy needs testing against every wallet connector first.
  headers: async () => [{ source: "/:path*", headers: SECURITY_HEADERS }],
};

export default config;
