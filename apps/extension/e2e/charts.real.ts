/**
 * "Explain this chart" on real chart pages, with the built extension in Chromium against a local Glance API: the marks
 * must land on the page's own chart (calibrated by canvas, DOM labels or vision), with Glance's own chart nowhere on
 * the page; or, when nothing lines up, nothing drawn and rule 3's question. A screenshot of each result goes to
 * docs/qa/chart-annotate-<site>-<symbol>.png, and the calibration method and R^2 (from Glance's own log line) to
 * docs/qa/chart-annotate.json. Live network (the pages, Yahoo's candles, Claude for the answer); no transaction.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test, type BrowserContext } from "@playwright/test";

const EXTENSION = resolve(import.meta.dirname, "../.output-e2e-real/chrome-mv3");
const API = process.env.E2E_REAL_API ?? "http://localhost:8791";
const QA = resolve(import.meta.dirname, "../../../docs/qa");

const CASES = [
  { site: "tradingview", symbol: "HOG", url: "https://www.tradingview.com/symbols/NYSE-HOG/", button: "LASTSESSION", range: "1 day", mustAnnotate: true },
  { site: "tradingview", symbol: "TSLA", url: "https://www.tradingview.com/symbols/NASDAQ-TSLA/", button: "5D", range: "5 days", mustAnnotate: true },
  { site: "tradingview", symbol: "NVDA", url: "https://www.tradingview.com/symbols/NASDAQ-NVDA/", button: "1M", range: "1 month", mustAnnotate: false },
  { site: "yahoo", symbol: "TSLA", url: "https://finance.yahoo.com/quote/TSLA/", button: null, range: "(the page's default)", mustAnnotate: false },
] as const;

let context: BrowserContext;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "glance-real-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // Pointed at the local API; past setup (the chart path needs no vault).
  await worker.evaluate(async (apiUrl) => {
    await chrome.storage.sync.set({ apiBaseUrl: apiUrl });
    await chrome.storage.local.set({ setupComplete: true });
  }, API);
});

test.afterAll(async () => {
  await context?.close();
});

for (const c of CASES) {
  test(`explain this chart: ${c.site} ${c.symbol} (${c.range})`, async () => {
    const page = await context.newPage();
    const lines: string[] = [];
    page.on("console", (m) => {
      if (m.text().startsWith("[glance] chart")) lines.push(m.text());
    });
    await page.goto(c.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(8_000);
    // Yahoo's consent wall, where it shows: accept, to reach the quote page.
    const consent = page.getByRole("button", { name: /accept all|agree|alles accepteren|alle akzeptieren|tout accepter/i });
    if (await consent.count()) {
      await consent.first().click().catch(() => {});
      await page.waitForTimeout(6_000);
    }
    if (c.site === "yahoo") {
      // Yahoo loads its chart when it scrolls into view.
      await page.mouse.wheel(0, 450);
      await page.waitForTimeout(8_000);
    }
    if (c.button) {
      await page.locator(`[data-qa-id=time-range-button-${c.button}]`).first().click();
      await page.waitForTimeout(3_000);
    }
    // The page's chart drawn (a canvas of chart size) before asking: a slow load otherwise has no chart yet.
    await page.waitForFunction(() => [...document.querySelectorAll("canvas")].some((el) => el.getBoundingClientRect().width > 200 && el.getBoundingClientRect().height > 110 && el.width > 0), null, { timeout: 45_000 });
    await page.waitForTimeout(1_500);
    await page.mouse.move(5, 5);
    const orb = page.getByRole("button", { name: /^Glance: / });
    await orb.waitFor({ timeout: 30_000 });
    await orb.press("Enter");
    const ask = page.getByRole("textbox", { name: "Ask Glance" });
    await ask.waitFor({ timeout: 15_000 });
    await ask.fill("explain this chart");
    await ask.press("Enter");
    // One log line per chart request, written when the answer's marks are in (or at once when nothing lines up).
    await expect.poll(() => lines.find((l) => /site=|no chart on this page|asked first/.test(l)) ?? null, { timeout: 120_000 }).not.toBeNull();
    await page.waitForTimeout(1_500);
    const line = lines.find((l) => /site=/.test(l)) ?? lines[0]!;
    const method = /method=(\w+)/.exec(line)?.[1] ?? "none";
    const r2 = /r2=([\d.]+)/.exec(line)?.[1] ?? null;
    const marks = await page.locator(".g-chart-layer [data-mark]").count();
    const ownChart = await page.locator(".g-own-chart, .g-lens").count();
    const shot = `docs/qa/chart-annotate-${c.site}-${c.symbol.toLowerCase()}.png`;
    await page.screenshot({ path: resolve(QA, `chart-annotate-${c.site}-${c.symbol.toLowerCase()}.png`) });
    const row = { site: c.site, symbol: c.symbol, range: c.range, method, r2, marks, ownChartShown: ownChart > 0, screenshot: shot, log: line };
    // One file per case (a worker restarted after a failure starts a fresh module): merged into chart-annotate.json.
    writeFileSync(resolve(QA, `.chart-annotate-${c.site}-${c.symbol.toLowerCase()}.json`), JSON.stringify(row));
    // Never Glance's own chart for "explain this chart".
    expect(ownChart).toBe(0);
    if (method === "none") {
      // Rule 3: nothing drawn, and the question asked.
      expect(marks).toBe(0);
      await expect(page.getByText("I can't line up marks on this chart. Want me to pull up my own?").first()).toBeVisible();
    } else {
      expect(["canvas", "dom", "vision"]).toContain(method);
      expect(marks).toBeGreaterThan(0);
    }
    if (c.mustAnnotate) expect(["canvas", "dom"]).toContain(method);
    await page.close();
  });
}
