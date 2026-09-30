/**
 * Marks stay after the answer: "Explain this chart" on TradingView TSLA (5 days), with the spoken answer on. When the
 * answer has finished playing, the marks on the chart (and any on the page) are counted, and again 15 seconds later:
 * all still there. A screenshot goes to docs/qa/marks-persist.png.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test } from "@playwright/test";

const EXTENSION = resolve(import.meta.dirname, "../.output-e2e-real/chrome-mv3");
const API = process.env.E2E_REAL_API ?? "http://localhost:8791";
const QA = resolve(import.meta.dirname, "../../../docs/qa");

test("marks are still on the chart 15 seconds after the answer ends", async () => {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "glance-marks-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async (apiUrl) => {
    await chrome.storage.sync.set({ apiBaseUrl: apiUrl, voiceReplies: true });
    await chrome.storage.local.set({ setupComplete: true, greeted: true, tourDone: true, hotkeyTips: 3 });
  }, API);
  for (const p of context.pages()) if (p.url().includes("/welcome.html")) await p.close();
  const page = await context.newPage();
  const lines: string[] = [];
  page.on("console", (m) => {
    if (m.text().startsWith("[glance]")) lines.push(m.text());
  });
  await page.goto("https://www.tradingview.com/symbols/NASDAQ-TSLA/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(6_000);
  await page.locator("[data-qa-id=time-range-button-5D]").first().click();
  await page.waitForFunction(() => [...document.querySelectorAll("canvas")].some((el) => el.getBoundingClientRect().width > 200 && el.width > 0), null, { timeout: 45_000 });
  await page.waitForTimeout(2_000);
  await page.mouse.move(5, 5);
  await page.getByRole("button", { name: /^Glance: / }).press("Enter");
  const ask = page.getByRole("textbox", { name: "Ask Glance" });
  await ask.waitFor({ timeout: 15_000 });
  await ask.fill("Explain this chart");
  await ask.press("Enter");
  // The answer has ended: its playback report comes after the last word.
  await expect.poll(() => lines.some((l) => l.startsWith("[glance] voice report")), { timeout: 150_000 }).toBe(true);
  // Locators reach into Glance's shadow root: the chart layer's marks, and the page's (text) marks.
  const count = async () => (await page.locator(".g-chart-layer [data-mark]").count()) + (await page.locator(".g-show-layer [data-mark]").count());
  const atEnd = await count();
  await page.waitForTimeout(15_000);
  const later = await count();
  await page.screenshot({ path: resolve(QA, "marks-persist.png") });
  writeFileSync(resolve(QA, "marks-persist.json"), `${JSON.stringify({ page: "tradingview TSLA 5 days", question: "Explain this chart", marksAtEnd: atEnd, marks15sLater: later }, null, 2)}\n`);
  console.log(`marks: ${atEnd} when the answer ended, ${later} 15s later`);
  expect(atEnd).toBeGreaterThan(0);
  expect(later).toBe(atEnd);
  await context.close();
});
