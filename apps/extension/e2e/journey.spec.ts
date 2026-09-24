/**
 * The gated setup journey, end to end, with the built extension in Chromium: the install page notices Glance; before
 * setup, Glance shows only its setup card (no underlines, no hover cards); setup completes (the console's handshake,
 * simulated with its real messages on the console page, and the mock API agreeing the browser is linked and the vault
 * funded); Glance flips to ready by itself, welcomes once, and a hover card's $10 buy confirms with a receipt. Against a
 * mock API (the chain mocked, the trade response canned): no real transaction, no key, no Claude call.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";

import { FAKE_TX, startMockApi, USER_VAULT, type MockApi } from "./mockApi";

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
  // A fresh install, pointed at the mock API and the e2e console. No vault: Glance starts gated.
  await worker.evaluate(({ apiUrl, consoleUrl }) => chrome.storage.sync.set({ apiBaseUrl: apiUrl, consoleUrl }), { apiUrl: api.url, consoleUrl: CONSOLE });
});

test.afterAll(async () => {
  await context?.close();
  await api?.close();
});

/** The word's centre on the page. */
async function wordAt(page: Page, id: string, word: string) {
  return page.evaluate(
    ({ id, word }) => {
      const text = document.getElementById(id)!.firstChild as Text;
      const i = text.data.indexOf(word);
      const r = document.createRange();
      r.setStart(text, i);
      r.setEnd(text, i + word.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    },
    { id, word },
  );
}

/** The console's side of the handshake, as its pages post it (window.postMessage to their own origin). */
async function consoleSays(page: Page, message: Record<string, unknown>) {
  await page.evaluate((m) => window.postMessage({ source: "glance-console", ...m }, window.location.origin), message);
}

test("gated setup journey: install, setup card, setup completes, ready, hover, buy, receipt", async () => {
  // 1. The install page notices Glance.
  const consolePage = await context.newPage();
  await consolePage.goto(`${CONSOLE}/install`);
  await expect(consolePage.getByRole("heading", { name: "You're set. Open any news article." })).toBeVisible({ timeout: 20_000 });

  // 2. Before setup: the article gets no underlines and no hover card; the orb opens only the setup card.
  const article = await context.newPage();
  await article.goto(`${api.url}/article.html`);
  const tesla = await wordAt(article, "lede", "Tesla");
  await article.mouse.move(tesla.x, tesla.y, { steps: 4 });
  await article.waitForTimeout(1_500);
  await expect(article.getByRole("button", { name: /^\$10$/ })).toHaveCount(0);
  await expect(article.getByRole("dialog", { name: "Welcome to Glance" })).toHaveCount(0); // no welcome before setup
  await article.getByRole("button", { name: /^Glance: / }).click();
  await expect(article.getByText("Set up Glance to start")).toBeVisible({ timeout: 10_000 });
  await expect(article.getByRole("button", { name: "Set me up" })).toBeVisible();
  await expect(article.getByRole("textbox", { name: "Ask Glance" })).toHaveCount(0);

  // 3. Setup completes in the console: the handshake sets the vault and reports the link (Glance checks it with the
  //    API, which now says linked; the vault holds USDG).
  const session = await consolePage.evaluate(
    () =>
      new Promise<string>((done) => {
        window.addEventListener("message", (e) => {
          if (e.source === window && e.data?.source === "glance-extension" && e.data.type === "GLANCE_HELLO") done(e.data.sessionAddress);
        });
        window.postMessage({ source: "glance-console", type: "GLANCE_PING" }, window.location.origin);
      }),
  );
  expect(session).toMatch(/^0x[0-9a-fA-F]{40}$/);
  api.setLinked(true);
  await consoleSays(consolePage, { type: "GLANCE_SET_VAULT", vault: USER_VAULT });
  await consoleSays(consolePage, { type: "GLANCE_LINKED", vault: USER_VAULT, sessionAddress: session, expiresAt: Math.floor(Date.now() / 1000) + 30 * 86_400 });

  // 4. Back on the article, Glance flips to ready by itself: the setup card goes, and the welcome shows (once).
  await article.bringToFront();
  await expect(article.getByText("Set up Glance to start")).toHaveCount(0, { timeout: 20_000 });
  const welcome = article.getByRole("dialog", { name: "Welcome to Glance" });
  await expect(welcome).toBeVisible({ timeout: 15_000 });
  await welcome.getByRole("button", { name: "Skip" }).click();

  // 5. Tesla is underlined now: hovering it opens the card; $10, Confirm, and the receipt.
  await expect(async () => {
    await article.mouse.move(tesla.x - 40, tesla.y + 60);
    await article.mouse.move(tesla.x, tesla.y, { steps: 4 });
    await expect(article.getByRole("button", { name: /^\$10$/ })).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 25_000 });
  await article.getByRole("button", { name: /^\$10$/ }).click();
  const confirm = article.getByRole("button", { name: "Confirm $10 of TSLA" });
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  await confirm.click();
  await expect(article.getByText("Bought 0.0263 TSLA", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(article.getByRole("link", { name: /tx 0xe2e0/ })).toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/tx/${FAKE_TX}`);
  expect(api.trades).toEqual([{ vault: USER_VAULT, symbol: "TSLA", side: "buy", amount: "10" }]);
});
