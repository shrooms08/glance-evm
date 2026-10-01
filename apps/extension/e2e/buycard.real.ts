/**
 * The buy card against a local API on the real chain: "buy $10 of Tesla" on the demo vault reaches the confirm step
 * (the quote's preflight is an eth_call simulation). Confirm is never pressed: nothing is sent.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test } from "@playwright/test";

const EXTENSION = resolve(import.meta.dirname, "../.output-e2e-real/chrome-mv3");
const API = process.env.E2E_REAL_API ?? "http://localhost:8791";
const QA = resolve(import.meta.dirname, "../../../docs/qa");
/** The demo vault the bug was reported on (the repo's own test fixtures name it). */
const DEMO_VAULT = "0x426B48569E52C9ad4fEc6F828102619575d60B20";

test("buy $10 of Tesla on the demo vault reaches Confirm (nothing sent)", async () => {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "glance-buy-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    viewport: { width: 1280, height: 860 },
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async ([apiUrl, vault]) => {
    await chrome.storage.sync.set({ apiBaseUrl: apiUrl, vaultAddress: vault });
    await chrome.storage.local.set({ setupComplete: true, greeted: true, tourDone: true });
  }, [API, DEMO_VAULT] as const);
  for (const p of context.pages()) if (p.url().includes("/welcome.html")) await p.close();
  const page = await context.newPage();
  const consoleLines: string[] = [];
  page.on("console", (m) => consoleLines.push(m.text()));
  // Where the report came from: the floating panel on TradingView's TSLA page.
  await page.goto("https://www.tradingview.com/symbols/NASDAQ-TSLA/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(6_000);
  await page.mouse.move(5, 5);
  await page.getByRole("button", { name: /^Glance: / }).press("Enter");
  const input = page.getByRole("textbox", { name: "Ask Glance" });
  await input.waitFor({ timeout: 20_000 });
  await input.fill("buy $10 of Tesla");
  await input.press("Enter");
  const confirm = page.getByRole("button", { name: /^Confirm \$10 of TSLA$/ });
  const visible = await page.evaluate(() => document.visibilityState);
  await expect(confirm)
    .toBeVisible({ timeout: 60_000 })
    .catch((e) => {
      console.log(`page visibility: ${visible}; console:\n${consoleLines.slice(-15).join("\n").slice(0, 2000)}`);
      throw e;
    });
  await page.screenshot({ path: resolve(QA, "buycard-confirm.png") });
  console.log(`buy card: reached "${await confirm.innerText()}"; chain warnings: ${consoleLines.filter((l) => l.includes("→ INTERNAL") || l.includes("→ RPC_UNAVAILABLE")).length}`);
  await context.close();
});
