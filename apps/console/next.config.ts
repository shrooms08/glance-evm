import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

import { assertPublicEnvSafe } from "./publicEnvGuard";

// Nothing secret may reach the browser bundle (an RPC URL with a key, a variable named like a secret).
assertPublicEnvSafe();

const here = dirname(fileURLToPath(import.meta.url));

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
};

export default config;
