/**
 * The voice under load: long spoken answers (Show me, sentence by sentence) on real chart pages, with the built
 * extension in Chromium against a local Glance API (real Deepgram voices). Each answer's playback report (lib/
 * voiceReport.ts: chunks, gaps, underruns, voices, sample rates, long tasks) is logged as it comes, then written with
 * the totals to docs/qa/voice-<VOICE_QA_LABEL>.json. Typed questions (no microphone); no transaction.
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";

const EXTENSION = resolve(import.meta.dirname, "../.output-e2e-real/chrome-mv3");
const API = process.env.E2E_REAL_API ?? "http://localhost:8791";
const LABEL = process.env.VOICE_QA_LABEL ?? "run";
const QA = resolve(import.meta.dirname, "../../../docs/qa");
const LOG = resolve(QA, `.voice-${LABEL}.jsonl`);

const PAGES = [
  { url: "https://www.tradingview.com/symbols/NASDAQ-TSLA/", button: "5D", questions: ["Explain this chart", "What's Tesla at and why is it moving?", "How am I doing?", "Where did it bounce this week?"] },
  { url: "https://www.tradingview.com/symbols/NASDAQ-NVDA/", button: "1M", questions: ["Explain this chart", "What's NVIDIA at and why is it moving?", "Walk me through the biggest drop on this chart"] },
  { url: "https://www.tradingview.com/symbols/NYSE-HOG/", button: "LASTSESSION", questions: ["Explain this chart", "What's Harley-Davidson at and why is it moving?", "How did it do today, from the open to now?"] },
  { url: "https://www.tradingview.com/symbols/NASDAQ-AMD/", button: "1M", questions: ["Explain this chart", "What's AMD at and why is it moving?", "Where did it bounce this month?"] },
].filter((p) => !process.env.VOICE_QA_ONLY || p.url.includes(process.env.VOICE_QA_ONLY));

interface Report {
  outcome: string;
  sentences: number;
  gaps: number[];
  breaks: number;
  underruns: number;
  voiceChanges: number;
  longTasks: Array<{ during: string | null; ms: number; where: string }>;
}

let context: BrowserContext;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "glance-voice-")), {
    channel: "chromium",
    headless: true,
    // As a person's browser runs it: no autoplay exemption (the offscreen document must be allowed to play by itself).
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async (apiUrl) => {
    await chrome.storage.sync.set({ apiBaseUrl: apiUrl, voiceReplies: true });
    await chrome.storage.local.set({ setupComplete: true });
  }, API);
});

test.afterAll(async () => {
  // Every answer so far (this worker's and any before a restart), from the log.
  const rows = existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { report: Report | null }) : [];
  const all = rows.map((r) => r.report).filter((r): r is Report => r !== null);
  const tasks = all.flatMap((r) => r.longTasks);
  const key = (t: Report["longTasks"][number]) => `${t.where}: ${t.during ?? "unlabelled"}`;
  const totals = {
    questions: rows.length,
    answers: all.length,
    sentences: all.reduce((s, r) => s + r.sentences, 0),
    breaks: all.reduce((s, r) => s + r.breaks, 0),
    underruns: all.reduce((s, r) => s + r.underruns, 0),
    voiceChanges: all.reduce((s, r) => s + r.voiceChanges, 0),
    notEnded: all.filter((r) => r.outcome !== "ended").length,
    maxGapMs: Math.max(0, ...all.flatMap((r) => r.gaps)),
    longTasks: tasks.length,
    longTasksByWork: tasks.reduce<Record<string, number>>((m, t) => ((m[key(t)] = (m[key(t)] ?? 0) + 1), m), {}),
  };
  writeFileSync(resolve(QA, `voice-${LABEL}.json`), `${JSON.stringify({ totals, answers: rows }, null, 2)}\n`);
  await context?.close();
});

/** One question, typed: its playback report, or null (with the page's last Glance lines) when none came. */
async function ask(page: Page, question: string): Promise<{ report: Report | null; note?: string[] }> {
  const lines: string[] = [];
  const onConsole = (m: { text(): string }) => {
    if (m.text().startsWith("[glance]")) lines.push(m.text());
  };
  page.on("console", onConsole);
  const input = page.getByRole("textbox", { name: "Ask Glance" });
  if (!(await input.isVisible())) await page.getByRole("button", { name: /^Glance: / }).press("Enter");
  await input.waitFor({ timeout: 15_000 });
  await input.fill(question);
  await input.press("Enter");
  const report = () => lines.find((l) => l.startsWith("[glance] voice report "));
  await expect
    .poll(() => Boolean(report()), { timeout: 120_000 })
    .toBe(true)
    .catch(() => {});
  page.off("console", onConsole);
  const line = report();
  if (line) return { report: JSON.parse(line.slice("[glance] voice report ".length)) as Report };
  // No report: what the page showed, for a look (VOICE_QA_SHOTS, a scratch folder).
  if (process.env.VOICE_QA_SHOTS) await page.screenshot({ path: resolve(process.env.VOICE_QA_SHOTS, `miss-${LABEL}-${question.replace(/\W+/g, "-").slice(0, 40)}.png`) }).catch(() => {});
  return { report: null, note: lines.slice(-6).map((l) => l.slice(0, 200)) };
}

for (const p of PAGES) {
  test(`spoken answers on ${p.url}`, async () => {
    const page = await context.newPage();
    await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6_000);
    await page.locator(`[data-qa-id=time-range-button-${p.button}]`).first().click();
    await page.waitForFunction(() => [...document.querySelectorAll("canvas")].some((el) => el.getBoundingClientRect().width > 200 && el.width > 0), null, { timeout: 45_000 });
    await page.waitForTimeout(2_000);
    await page.mouse.move(5, 5);
    for (const q of p.questions) {
      const got = await ask(page, q);
      appendFileSync(LOG, `${JSON.stringify({ page: p.url, question: q, ...got })}\n`);
      await page.waitForTimeout(1_500);
    }
    await page.close();
  });
}
