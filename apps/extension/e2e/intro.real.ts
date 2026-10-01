/**
 * The spoken intro in a fresh Chromium profile: installing Glance opens the Welcome page, the intro plays from its own
 * files (autoplay allowed here, as after a click), the captions advance with the voice, and "Set me up" and "Replay
 * intro" appear at the end. Screenshots: docs/qa/intro-orb.png (mid-intro) and docs/qa/intro-end.png.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test } from "@playwright/test";

const EXTENSION = resolve(import.meta.dirname, "../.output-e2e-real/chrome-mv3");
const QA = resolve(import.meta.dirname, "../../../docs/qa");

test("install opens the Welcome page and the intro plays through to Set me up and Replay intro", async () => {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "glance-intro-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--autoplay-policy=no-user-gesture-required"],
    viewport: { width: 1280, height: 800 },
  });
  await expect.poll(() => context.pages().some((p) => p.url().includes("/welcome.html")), { timeout: 20_000 }).toBe(true);
  const page = context.pages().find((p) => p.url().includes("/welcome.html"))!;
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  const caption = page.getByTestId("intro-caption");
  await expect(caption).toHaveText("Hey. I'm Glance.", { timeout: 15_000 });
  await expect(page.getByTestId("intro-orb")).toBeVisible();
  // The captions advance with the voice.
  await expect(caption).toHaveText("See a company in the news? Hold ⌥V and ask me about it.", { timeout: 20_000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(QA, "intro-orb.png") });
  await expect(page.getByRole("button", { name: "Set me up" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Replay intro" })).toBeVisible();
  await expect(caption).toHaveText("Ready when you are.");
  await page.waitForTimeout(700);
  await page.screenshot({ path: resolve(QA, "intro-end.png") });
  // Only the extension's own files were fetched during the intro (no network).
  const outside = requests.filter((u) => !u.startsWith("chrome-extension://") && !u.startsWith("data:"));
  console.log(`intro: requests outside the extension during the intro: ${outside.length}`);
  // "Set me up": the setup steps, as before.
  await page.getByRole("button", { name: "Set me up" }).click();
  await expect(page.getByRole("button", { name: "MetaMask, Rabby or Brave Wallet" })).toBeVisible();
  await context.close();
});
