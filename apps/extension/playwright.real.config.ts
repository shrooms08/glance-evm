import { defineConfig } from "@playwright/test";

/**
 * The real-site chart check (live TradingView and Yahoo pages, a local API): `pnpm --filter extension e2e:real`.
 * Separate from the journey (`pnpm e2e`), which never touches the network.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: /(charts|voice|candles)\.real\.ts$/,
  timeout: 900_000,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "off" },
});
