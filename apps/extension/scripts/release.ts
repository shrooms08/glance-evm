/**
 * The downloadable extension, for installing without a store:
 *
 *   pnpm release:extension          (from the repo root; or pnpm --filter extension release)
 *
 * Builds the production extension against the hosted Glance (API_URL and CONSOLE_URL override the defaults below),
 * then copies the zip into the console's public files, where the console serves it:
 *   apps/console/public/downloads/glance-extension-<version>.zip
 *   apps/console/public/downloads/glance-extension-latest.zip   (the stable link the "Get Glance" page uses)
 */
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { buildProd } from "./build-prod.ts";

export const HOSTED_API_URL = "https://api-production-adb0.up.railway.app";
export const HOSTED_CONSOLE_URL = "https://glance-evm-console.vercel.app";
/** Where the console serves the zip from (apps/console/public/downloads). */
export const DOWNLOADS = resolve(import.meta.dirname, "../../console/public/downloads");
export const LATEST_ZIP = "glance-extension-latest.zip";

if (process.argv[1]?.endsWith("release.ts")) {
  try {
    const { zip, version } = buildProd(process.env.API_URL || HOSTED_API_URL, process.env.CONSOLE_URL || HOSTED_CONSOLE_URL);
    mkdirSync(DOWNLOADS, { recursive: true });
    const versioned = resolve(DOWNLOADS, `glance-extension-${version}.zip`);
    copyFileSync(zip, versioned);
    copyFileSync(zip, resolve(DOWNLOADS, LATEST_ZIP));
    const kb = Math.round(statSync(versioned).size / 1024);
    console.log(`release: ${versioned} (${kb} KB)`);
    console.log(`release: ${resolve(DOWNLOADS, LATEST_ZIP)}`);
    console.log(`release: served at ${process.env.CONSOLE_URL || HOSTED_CONSOLE_URL}/downloads/${LATEST_ZIP} once the console deploys`);
  } catch (err) {
    console.error(`release: ${(err as Error).message}`);
    process.exit(1);
  }
}
