/**
 * First run in a fresh Chromium profile: installing Glance opens the Welcome page (not Settings), and its wallet button
 * lands on the console's existing Get started page. A screenshot goes to docs/qa/welcome-first-run.png.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test } from "@playwright/test";

import { HOSTED_CONSOLE_URL } from "../scripts/release.ts";

const EXTENSION = resolve(import.meta.dirname, "../.output-e2e-real/chrome-mv3");
const QA = resolve(import.meta.dirname, "../../../docs/qa");

test("install opens the Welcome page, and its setup button opens the console's Get started", async () => {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "glance-welcome-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    viewport: { width: 1280, height: 860 },
  });
  const welcome = await expect
    .poll(() => context.pages().find((p) => p.url().includes("/welcome.html")) ?? null, { timeout: 20_000 })
    .not.toBeNull()
    .then(() => context.pages().find((p) => p.url().includes("/welcome.html"))!);
  expect(welcome.url()).toContain("installed=1");
  expect(context.pages().some((p) => p.url().includes("/options.html"))).toBe(false);
  await welcome.getByRole("heading", { name: "Hey. I'm Glance." }).waitFor();
  await expect(welcome.getByText("I'm installed. I live on every page you read")).toBeVisible();
  await welcome.waitForTimeout(800);
  await welcome.screenshot({ path: resolve(QA, "welcome-first-run.png") });

  // Pointed at the hosted console (the release build's), so the button lands on a real Get started page.
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async (url) => chrome.storage.sync.set({ consoleUrl: url }), HOSTED_CONSOLE_URL);
  const opened = context.waitForEvent("page");
  await welcome.getByRole("button", { name: "MetaMask, Rabby or Brave Wallet" }).click();
  const start = await opened;
  await start.waitForURL(/\/start(\?|$)/, { timeout: 30_000 }).catch(() => {});
  console.log(`welcome: the setup button opened ${new URL(start.url()).pathname}`);
  expect(new URL(start.url()).origin).toBe(new URL(HOSTED_CONSOLE_URL).origin);
  await start.getByText("Five steps to your own vault").waitFor({ timeout: 30_000 });
  await start.screenshot({ path: resolve(QA, "welcome-setup-start.png") });
  expect(new URL(start.url()).pathname).toBe("/start");
  // The Welcome page now waits for the console.
  await expect(welcome.getByText("Connect your wallet in the Glance tab.")).toBeVisible();
  await context.close();
});
