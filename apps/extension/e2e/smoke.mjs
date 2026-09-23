// Loads the built extension into Chromium and exercises it on a real news article.
// Usage: pnpm build && node e2e/smoke.mjs [url] [outDir]   (needs the API running on http://localhost:8790)
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const url = process.argv[2] || "https://www.cnbc.com/2026/09/04/teslas-stock-drops-as-cybercab-update-underwhelms-nhtsa-probe.html";
const out = resolve(process.argv[3] || "e2e/out");
mkdirSync(out, { recursive: true });
const ext = resolve(".output/chrome-mv3");
// The TestUSDG fallback vault: its $150 -> $100 retry needs more than the Paxos vault's 60 USDG to reach a review.
const DEMO_VAULT = process.env.DEMO_VAULT ?? "0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D";

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  viewport: { width: 1360, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const id = new URL(sw.url()).host;
console.log("extension id:", id);
await sw.evaluate((v) => chrome.storage.sync.set({ vaultAddress: v }), DEMO_VAULT);
for (const p of ctx.pages()) if (p.url().includes("options.html")) await p.close(); // first-run settings tab

const extConsole = [];
const page = await ctx.newPage();
page.on("requestfailed", (r) => {
  if (r.url().startsWith("chrome-extension://") || r.frame() === page.mainFrame()) {
    if (r.url().startsWith("chrome-extension://")) extConsole.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  }
});
page.on("console", (m) => {
  if (m.location().url.startsWith("chrome-extension://")) extConsole.push(`${m.type()}: ${m.text()}`);
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(6_000);
// Accept the site's consent banner like a reader would: while open it puts a backdrop over the article.
for (const name of ["Continue", "Accept", "I Accept", "Accept All", "Agree"]) {
  const b = page.getByRole("button", { name, exact: true });
  if (await b.first().isVisible().catch(() => false)) {
    await b.first().click().catch(() => {});
    break;
  }
}
await page.waitForTimeout(6_000);

const found = await page.evaluate(() => {
  const host = document.querySelector("glance-orb");
  const hl = CSS.highlights?.get("glance-company");
  const ranges = hl ? [...hl] : [];
  return {
    title: document.title,
    shadowOrb: Boolean(host?.shadowRoot?.querySelector(".g-orb")),
    hostOutsideBody: host?.parentElement === document.documentElement,
    mentions: ranges.length,
    texts: [...new Set(ranges.map((r) => r.toString()))],
  };
});
console.log(JSON.stringify(found, null, 1));
await page.screenshot({ path: `${out}/1-article.png` });

if (found.mentions > 0) {
  // Hover the first visible mention.
  const pt = await page.evaluate(() => {
    const ranges = [...CSS.highlights.get("glance-company")];
    for (const r of ranges) {
      const rect = r.getClientRects()[0];
      if (rect && rect.top > 80 && rect.bottom < innerHeight - 40) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: r.toString() };
    }
    const r = ranges[0];
    r.startContainer.parentElement.scrollIntoView({ block: "center" });
    const rect = r.getClientRects()[0];
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: r.toString() };
  });
  await page.mouse.move(pt.x - 40, pt.y);
  await page.mouse.move(pt.x, pt.y, { steps: 5 });
  await page.waitForTimeout(2_500);
  const card = page.locator("glance-orb .g-pop");
  console.log("hovered:", pt.text, "card visible:", await card.isVisible());
  await page.screenshot({ path: `${out}/2-hover-card.png` });

  // A $150 buy: over the $100 per-trade cap, so the vault must hold it back.
  await card.locator('input[aria-label="Custom amount in dollars"]').fill("150");
  await card.locator('button[type="submit"]').click();
  await page.locator("glance-orb .g-guard").waitFor({ timeout: 30_000 });
  console.log("blocked card:", (await page.locator("glance-orb .g-guard").innerText()).replace(/\n+/g, " | "));
  await page.screenshot({ path: `${out}/3-blocked.png` });

  // Retry at the cap from the blocked card: must pass the preflight and reach review.
  await page.locator("glance-orb .g-guard .g-btn-primary").click();
  try {
    await page.locator("glance-orb .g-pop").getByText(/Confirm \$/).waitFor({ timeout: 30_000 });
  } catch (err) {
    await page.screenshot({ path: `${out}/4-review-failed.png` });
    console.log("after retry:", (await page.locator("glance-orb").innerText().catch(() => "(no card)")).replace(/\n+/g, " | "));
    throw err;
  }
  console.log("review:", (await page.locator("glance-orb .g-pop").innerText()).replace(/\n+/g, " | "));
  await page.screenshot({ path: `${out}/4-review.png` });
}

// Open the floating panel by keyboard.
await page.mouse.move(10, 10);
await page.keyboard.press("Escape");
await page.locator("glance-orb .g-orb-button").focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(1_500);
await page.screenshot({ path: `${out}/5-panel.png` });

// Settings page and its connection test.
const opts = await ctx.newPage();
await opts.goto(`chrome-extension://${id}/options.html`);
await opts.getByText("Test connection").click();
await opts.waitForTimeout(3_000);
await opts.screenshot({ path: `${out}/6-settings.png`, fullPage: true });

// The side panel's tall layout, rendered as a page.
const side = await ctx.newPage();
await side.setViewportSize({ width: 400, height: 860 });
await side.goto(`chrome-extension://${id}/sidepanel.html`);
await side.waitForTimeout(3_000);
await side.screenshot({ path: `${out}/7-sidepanel.png` });

console.log("extension console messages:", extConsole.length ? extConsole : "none");
await ctx.close();
