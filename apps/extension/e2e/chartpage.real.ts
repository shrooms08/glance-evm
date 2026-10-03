/**
 * TradingView's full chart page (tradingview.com/chart/?symbol=NASDAQ:TSLA), candles, with 5D and with 1M picked on
 * its range bar: "Explain this chart" and "Any candle patterns here?" must mark the page's own candles without asking
 * (the range is read from the range bar), or ask at most once (then answered with the same range's button, and never
 * asked again). Screenshots to docs/qa/chart-page-tsla-<range>.png (the explanation's marks, the panel open) and
 * docs/qa/chart-page-tsla-<range>-patterns.png, the calibration method and R^2 (Glance's own log line) to
 * docs/qa/chart-page.json. Live network (the page, Yahoo's candles, Claude for the answer); no transaction.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";

const EXTENSION = resolve(import.meta.dirname, "../.output-e2e-real/chrome-mv3");
const API = process.env.E2E_REAL_API ?? "http://localhost:8791";
const QA = resolve(import.meta.dirname, "../../../docs/qa");
const URL = "https://www.tradingview.com/chart/?symbol=NASDAQ%3ATSLA";

const CASES = [
  { tab: "5D", range: "1W", file: "chart-page-tsla-5d" },
  { tab: "1M", range: "1M", file: "chart-page-tsla-1m" },
] as const;

let context: BrowserContext;
const rows: Array<Record<string, unknown>> = [];

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "glance-chartpage-")), {
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
  const file = resolve(QA, "chart-page.json");
  const before = (() => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  })();
  const keyOf = (r: Record<string, unknown>) => `${r.range}|${r.question}`;
  const merged = [...before.filter((r) => !rows.some((n) => keyOf(n) === keyOf(r))), ...rows];
  if (rows.length) writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
});

/** Asks in the panel; at most one question back (answered with `tab`'s button). Returns the log lines and the asks. */
async function ask(page: Page, lines: string[], question: string, tab: string, done: RegExp) {
  const from = lines.length;
  const box = page.getByRole("textbox", { name: "Ask Glance" });
  if (!(await box.isVisible().catch(() => false))) await page.getByRole("button", { name: /^Glance: / }).press("Enter");
  await box.waitFor({ timeout: 15_000 });
  await box.fill(question);
  await box.press("Enter");
  let asks = 0;
  await expect
    .poll(
      async () => {
        const mine = lines.slice(from);
        if (mine.some((l) => done.test(l))) return true;
        if (mine.filter((l) => l.includes("asked first")).length > asks) {
          asks++;
          // Asked: the range bar's tab as the answer (asked once at most is the rule).
          await page.getByRole("button", { name: tab, exact: true }).last().click({ timeout: 5_000 }).catch(() => {});
        }
        return false;
      },
      { timeout: 150_000, intervals: [1_000] },
    )
    .toBe(true);
  return { lines: lines.slice(from), asks };
}

for (const c of CASES) {
  test(`TradingView chart page, TSLA ${c.tab}: explain and candle patterns, asked at most once`, async () => {
    const page = await context.newPage();
    const lines: string[] = [];
    page.on("console", (m) => {
      if (m.text().startsWith("[glance]")) lines.push(m.text());
    });
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(() => [...document.querySelectorAll("canvas")].some((el) => el.getBoundingClientRect().width > 200 && el.getBoundingClientRect().height > 110 && el.width > 0), null, { timeout: 45_000 });
    await page.waitForTimeout(6_000);
    await page.locator(`[data-name=date-range-tab-${c.tab}]`).first().click();
    await page.waitForTimeout(3_000);
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.move(5, 5);
    await page.getByRole("button", { name: /^Glance: / }).waitFor({ timeout: 30_000 });

    // 1. "Explain this chart": the marks on the page's candles.
    const explain = await ask(page, lines, "Explain this chart", c.tab, /^\[glance\] chart "Explain this chart": site=/);
    const line = explain.lines.find((l) => /site=/.test(l))!;
    const method = /method=(\w+)/.exec(line)?.[1] ?? "none";
    const r2 = /r2=([\d.]+)/.exec(line)?.[1] ?? null;
    const range = /range=(\w+)/.exec(line)?.[1] ?? null;
    await page.waitForTimeout(2_000);
    const marks = await page.locator(".g-chart-layer [data-mark]").count();
    // With the panel open, as charts.real.ts: the explanation's marks go with the panel.
    await page.getByRole("button", { name: /^Skip/ }).first().click({ timeout: 2_000 }).catch(() => {});
    await page.mouse.move(5, 5);
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(QA, `${c.file}.png`) });
    rows.push({ page: URL, range: c.tab, question: "Explain this chart", asked: explain.asks, method, r2, rangeUsed: range, marks, screenshot: `docs/qa/${c.file}.png`, log: line });

    // 2. "Any candle patterns here?": the formations' boxes on the same candles.
    const patterns = await ask(page, lines, "Any candle patterns here?", c.tab, /^\[glance\] candles "Any candle patterns here\?"|^\[glance\] chart "Any candle patterns here\?": .*method=none/);
    const pLine = patterns.lines.find((l) => l.startsWith("[glance] candles")) ?? patterns.lines.find((l) => /method=none/.test(l))!;
    const found = JSON.parse(/found=(\[.*?\])/.exec(pLine)?.[1] ?? "[]") as string[];
    await page.waitForTimeout(2_500);
    const boxes = await page.locator(".g-chart-layer [data-mark=pattern]").count();
    await page.getByRole("button", { name: "Close Glance" }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(QA, `${c.file}-patterns.png`) });
    const calLine = patterns.lines.find((l) => /^\[glance\] chart "Any candle patterns here\?": site=/.test(l)) ?? "";
    rows.push({
      page: URL,
      range: c.tab,
      question: "Any candle patterns here?",
      asked: patterns.asks,
      method: /method=(\w+)/.exec(calLine)?.[1] ?? null,
      r2: /r2=([\d.]+)/.exec(calLine)?.[1] ?? null,
      found,
      boxes,
      screenshot: `docs/qa/${c.file}-patterns.png`,
      log: pLine,
    });

    // Read from the range bar: never asked (and at most once in all, the rule).
    expect(explain.asks + patterns.asks).toBeLessThanOrEqual(1);
    expect(explain.asks).toBe(0);
    expect(range).toBe(c.range);
    expect(["canvas", "dom", "vision"]).toContain(method);
    expect(marks).toBeGreaterThan(0);
    // Every formation named has its box on the chart.
    expect(pLine.startsWith("[glance] candles")).toBe(true);
    expect(boxes).toBe(found.length);
    await page.close();
  });
}
