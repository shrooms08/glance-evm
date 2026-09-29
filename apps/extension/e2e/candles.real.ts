/**
 * "Any candle patterns here?" on real chart pages, with the built extension in Chromium against a local Glance API:
 * the formations are found in code from the market candles the page's chart was calibrated against, and each one's
 * box lands on the page's own chart. A screenshot of each result goes to docs/qa/candles-<site>-<symbol>.png, and
 * the patterns found and marks drawn (from Glance's own log line) to docs/qa/candles.json. Live network (the pages,
 * Yahoo's candles); no transaction.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test, type BrowserContext } from "@playwright/test";

const EXTENSION = resolve(import.meta.dirname, "../.output-e2e-real/chrome-mv3");
const API = process.env.E2E_REAL_API ?? "http://localhost:8791";
const QA = resolve(import.meta.dirname, "../../../docs/qa");

const CASES = [
  { site: "tradingview", symbol: "TSLA", url: "https://www.tradingview.com/symbols/NASDAQ-TSLA/", button: "5D", range: "5 days", file: "tradingview-tsla" },
  { site: "tradingview", symbol: "NVDA", url: "https://www.tradingview.com/symbols/NASDAQ-NVDA/", button: "1M", range: "1 month", file: "tradingview-nvda" },
  // The full chart page: candles by default, daily.
  { site: "tradingview chart", symbol: "TSLA", url: "https://www.tradingview.com/chart/?symbol=NASDAQ%3ATSLA", button: null, range: "(the page's default)", file: "tradingview-chart-tsla" },
].filter((c) => !process.env.CANDLES_ONLY || c.file === process.env.CANDLES_ONLY);

let context: BrowserContext;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "glance-candles-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async (apiUrl) => {
    await chrome.storage.sync.set({ apiBaseUrl: apiUrl });
    await chrome.storage.local.set({ setupComplete: true });
  }, API);
});

test.afterAll(async () => {
  await context?.close();
});

for (const c of CASES) {
  test(`any candle patterns here: ${c.site} ${c.symbol} (${c.range})`, async () => {
    const page = await context.newPage();
    const lines: string[] = [];
    page.on("console", (m) => {
      if (m.text().startsWith("[glance]")) lines.push(m.text());
    });
    await page.goto(c.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(8_000);
    if (c.button) {
      await page.locator(`[data-qa-id=time-range-button-${c.button}]`).first().click();
      await page.waitForTimeout(3_000);
    }
    // A sign-in wall over the chart page, where TradingView shows one: noted, and closed if it can be.
    const wall = await page.getByText(/sign in|log in|join for free/i).first().isVisible().catch(() => false);
    const chartDrawn = await page
      .waitForFunction(() => [...document.querySelectorAll("canvas")].some((el) => el.getBoundingClientRect().width > 200 && el.getBoundingClientRect().height > 110 && el.width > 0), null, { timeout: 45_000 })
      .then(() => true, () => false);
    await page.waitForTimeout(1_500);
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.move(5, 5);
    const shot = `docs/qa/candles-${c.file}.png`;
    const write = (row: Record<string, unknown>) => writeFileSync(resolve(QA, `.candles-${c.file}.json`), JSON.stringify({ site: c.site, symbol: c.symbol, range: c.range, screenshot: shot, ...row }));
    if (!chartDrawn) {
      await page.screenshot({ path: resolve(QA, `candles-${c.file}.png`) });
      write({ series: null, found: [], marks: 0, note: wall ? "a sign-in wall; no chart drawn" : "no chart drawn" });
      test.skip(true, "no chart on the page");
    }
    const orb = page.getByRole("button", { name: /^Glance: / });
    await orb.waitFor({ timeout: 30_000 });
    await orb.press("Enter");
    const ask = page.getByRole("textbox", { name: "Ask Glance" });
    await ask.waitFor({ timeout: 15_000 });
    await ask.fill("Any candle patterns here?");
    await ask.press("Enter");
    // One log line when the answer's marks are in; rule 3, a question first, or no chart otherwise.
    await expect.poll(() => lines.find((l) => /^\[glance\] candles|method=none|asked first|no chart on this page/.test(l)) ?? null, { timeout: 120_000 }).not.toBeNull();
    await page.waitForTimeout(2_500);
    const line = lines.find((l) => l.startsWith("[glance] candles")) ?? lines.find((l) => /method=none|asked first|no chart/.test(l))!;
    const found = JSON.parse(/found=(\[.*?\])/.exec(line)?.[1] ?? "[]") as string[];
    const series = /series=(\w+)/.exec(line)?.[1] ?? null;
    const marks = await page.locator(".g-chart-layer [data-mark=pattern]").count();
    const said = (await page.locator("[data-glance-layer], .g-orb, .g-panel").allInnerTexts().catch(() => [])).join(" ");
    // How the spoken answer went (the player's report), once it has played.
    await expect.poll(() => lines.some((l) => l.startsWith("[glance] voice report")), { timeout: 60_000 }).toBe(true).catch(() => {});
    const report = lines.find((l) => l.startsWith("[glance] voice report"));
    const voice = report ? (JSON.parse(report.slice("[glance] voice report ".length)) as { outcome: string; breaks: number }) : null;
    // The panel closed (the marks stay), so the screenshot shows the chart's newest bars.
    await page.getByRole("button", { name: "Close Glance" }).first().click().catch(() => {});
    // The first-run tour card, where it shows over the chart's newest bars.
    await page.getByRole("button", { name: /^Skip/ }).first().click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(QA, `candles-${c.file}.png`) });
    write({ series, found, marks, voice: voice ? { outcome: voice.outcome, breaks: voice.breaks } : null, ...(wall ? { note: "a sign-in prompt showed; the chart was still readable" } : {}), log: line, ...(process.env.CANDLES_DEBUG ? { glance: lines.map((l) => l.slice(0, 300)) } : {}) });
    // Every formation named is drawn on the page's chart (or, with nothing lined up, nothing is drawn: rule 3).
    if (line.startsWith("[glance] candles")) expect(marks).toBe(found.length);
    else expect(marks).toBe(0);
    if (series === "line") expect(said).toContain("Switch the chart to candles to see it clearly.");
    await page.close();
  });
}
