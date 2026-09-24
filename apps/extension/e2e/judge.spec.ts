/**
 * The judge journey, end to end, with the built extension loaded in Chromium: the install page notices Glance, the orb
 * welcomes, a news article's company is underlined, hovering it opens the card, "Try a $10 demo buy", Confirm, and the
 * receipt with its explorer link. Against a mock API (the chain mocked, the trade response canned): no real transaction.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";

import { DEMO_VAULT, FAKE_TX, startMockApi, type MockApi } from "./mockApi";

const EXTENSION = resolve(import.meta.dirname, "../.output-e2e/chrome-mv3");
const CONSOLE = process.env.E2E_CONSOLE_URL ?? "http://localhost:3999";

let api: MockApi;
let context: BrowserContext;

test.beforeAll(async () => {
  api = await startMockApi(Number(process.env.E2E_API_PORT ?? 8797));
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "glance-e2e-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    viewport: { width: 1280, height: 860 },
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // A fresh install, pointed at the mock API and the e2e console. Nothing else is set: the demo vault is the default.
  await worker.evaluate(({ apiUrl, consoleUrl }) => chrome.storage.sync.set({ apiBaseUrl: apiUrl, consoleUrl }), { apiUrl: api.url, consoleUrl: CONSOLE });
});

test.afterAll(async () => {
  await context?.close();
  await api?.close();
});

/** Moves the mouse onto a word on the page until Glance's hover card opens (the underline arrives after a scan). */
async function hoverWord(page: Page, id: string, word: string) {
  const box = await page.evaluate(
    ({ id, word }) => {
      const el = document.getElementById(id)!;
      const text = el.firstChild as Text;
      const i = text.data.indexOf(word);
      const r = document.createRange();
      r.setStart(text, i);
      r.setEnd(text, i + word.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    },
    { id, word },
  );
  await expect(async () => {
    await page.mouse.move(box.x - 40, box.y + 60);
    await page.mouse.move(box.x, box.y, { steps: 4 });
    await expect(page.getByRole("button", { name: "Try a $10 demo buy" })).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 20_000 });
}

test("judge journey: install, welcome, hover, demo buy, receipt", async () => {
  // 1. The install page notices Glance and moves on by itself.
  const install = await context.newPage();
  await install.goto(`${CONSOLE}/install`);
  await expect(install.getByRole("heading", { name: "You're set. Open any news article." })).toBeVisible({ timeout: 20_000 });

  // 2. The orb's welcome, once (shown on the first page Glance runs on). Skip the tour.
  const welcome = install.getByRole("dialog", { name: "Welcome to Glance" });
  await expect(welcome).toBeVisible({ timeout: 15_000 });
  await expect(welcome).toContainText("Glance");
  await welcome.getByRole("button", { name: "Skip" }).click();
  await expect(welcome).toBeHidden();

  // 3. A news article: Tesla is underlined; hovering it opens the card, on the demo vault by default.
  const page = await context.newPage();
  await page.goto(`${api.url}/article.html`);
  await expect(page.getByRole("dialog", { name: "Welcome to Glance" })).toHaveCount(0); // once only
  await hoverWord(page, "lede", "Tesla");

  // 4. "Try a $10 demo buy", then Confirm.
  await page.getByRole("button", { name: "Try a $10 demo buy" }).click();
  const confirm = page.getByRole("button", { name: "Confirm $10 of TSLA" });
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Passed every vault guard in a dry run")).toBeVisible();
  await confirm.click();

  // 5. The receipt, with its explorer link.
  await expect(page.getByText("Bought 0.0263 TSLA")).toBeVisible({ timeout: 15_000 });
  const link = page.getByRole("link", { name: /tx 0xe2e0/ });
  await expect(link).toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/tx/${FAKE_TX}`);
  expect(api.trades).toEqual([{ vault: DEMO_VAULT, symbol: "TSLA", side: "buy", amount: "10" }]);
});
