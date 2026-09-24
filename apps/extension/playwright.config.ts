import { defineConfig } from "@playwright/test";

/** The judge journey, end to end, with the built extension in Chromium (run it with `pnpm --filter extension e2e`). */
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
});
