// Real-browser check of the hotkeys, the gooey open and close, orb-click docking, and surviving an extension reload,
// on a heavy news page. Usage: pnpm build && node e2e/interaction.mjs [url] [outDir]   (API on http://localhost:8790)
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const url = process.argv[2] || "https://www.cnbc.com/2026/09/04/teslas-stock-drops-as-cybercab-update-underwhelms-nhtsa-probe.html";
const out = resolve(process.argv[3] || "e2e/out");
mkdirSync(out, { recursive: true });
const ext = resolve(".output/chrome-mv3");
const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  viewport: { width: 1360, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
for (const p of ctx.pages()) if (p.url().includes("options.html")) await p.close();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
};

const page = await ctx.newPage();
const extErrors = [];
page.on("console", (m) => {
  if (m.type() === "error" && /glance|chrome-extension|Extension context/i.test(`${m.text()} ${m.location().url}`)) extErrors.push(m.text());
});
page.on("pageerror", (e) => /Extension context/i.test(e.message) && extErrors.push(e.message));
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(5_000);
for (const name of ["Continue", "Accept", "I Accept", "Accept All", "Agree"]) {
  const b = page.getByRole("button", { name, exact: true });
  if (await b.first().isVisible().catch(() => false)) await b.first().click().catch(() => {});
}
await page.locator("glance-orb .g-orb").waitFor({ timeout: 20_000 });
await page.waitForTimeout(4_000); // let the underliner finish

const orbState = () => page.locator("glance-orb .g-orb-button .g-orb").getAttribute("data-state");
const sampleStates = async (ms) => {
  const seen = new Set();
  const until = Date.now() + ms;
  while (Date.now() < until) {
    seen.add(await orbState());
    await page.waitForTimeout(40);
  }
  return [...seen];
};

// 1. Option+G, tap: glance. Opens the panel, says what was found, never listens.
await page.keyboard.down("Alt");
await page.keyboard.press("KeyG");
await page.keyboard.up("Alt");
const statesAfterG = await sampleStates(900);
const line = (await page.locator("glance-orb .g-panel .g-body").first().innerText()).trim();
check("Option+G opens the panel with what was found", /^Reading cnbc\.com, (\d+ names? found|no names found)/.test(line), line);
check("Option+G never listens", !statesAfterG.includes("listening"), `orb states seen: ${statesAfterG.join(", ")}`);
const panel = page.locator("glance-orb .g-panel");
await page.locator('glance-orb .g-panel[data-phase="open"]').waitFor({ timeout: 2_000 }).catch(() => {});
check("panel settled open, liquid stage gone", (await panel.getAttribute("data-phase")) === "open" && (await page.locator("glance-orb .g-goo-stage").count()) === 0);
const frames = await panel.getAttribute("data-goo-frames");
const quality = await panel.getAttribute("data-goo-quality");
// Headless Chromium on a busy page is janky on its own; this records the numbers rather than judging them.
check("goo frame timing measured", Boolean(frames && quality), `${frames} · quality ${quality}`);

// 2. Escape closes (collapsing back into the orb).
await page.keyboard.press("Escape");
await panel.waitFor({ state: "detached", timeout: 2_000 }).catch(() => {});
check("Escape closes the panel", (await panel.count()) === 0);

// 3. Visual: a mid-animation frame of the open and the close.
await page.keyboard.down("Alt");
await page.keyboard.press("KeyG");
await page.keyboard.up("Alt");
await page.waitForTimeout(90);
const clip = { x: 1360 - 420, y: 900 - 700, width: 420, height: 700 };
await page.screenshot({ path: `${out}/goo-opening.png`, clip });
await page.locator('glance-orb .g-panel[data-phase="open"]').waitFor({ timeout: 3_000 }).catch(() => {});
await page.screenshot({ path: `${out}/goo-open.png`, clip });
const stageFilterInShadow = await page.evaluate(() => {
  const root = document.querySelector("glance-orb")?.shadowRoot;
  return root ? root.querySelectorAll("filter").length : -1;
});
await page.keyboard.press("Escape");
await page.waitForTimeout(170);
await page.screenshot({ path: `${out}/goo-closing.png`, clip });
await page.waitForTimeout(600);
check("no filter left behind at rest", stageFilterInShadow === 0, `filters in shadow root while open: ${stageFilterInShadow}`);

// 4. Option+V, hold: listening while held, then off the listening state after release.
await page.keyboard.down("Alt");
await page.keyboard.down("KeyV");
await page.waitForTimeout(1_200);
const held = await orbState();
await page.keyboard.up("KeyV");
await page.keyboard.up("Alt");
const afterRelease = await sampleStates(6_500);
const heldLine = (await page.locator("glance-orb .g-panel .g-body").first().innerText().catch(() => "")).trim();
const heldMeta = (await page.locator("glance-orb .g-panel .g-data").first().innerText().catch(() => "")).trim();
check("Option+V listens while held", held === "listening", `data-state=${held} · panel after release: "${heldLine}" · ${heldMeta}`);
check("release ends listening", afterRelease.at(-1) !== "listening", `states after release: ${afterRelease.join(", ")}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

// 4b. Springs: the orb trails a drag and settles exactly under the cursor; idle breathing depends on the page's budget.
const orbBox = await page.locator("glance-orb .g-orb-button").boundingBox();
await page.mouse.move(orbBox.x + 32, orbBox.y + 32);
await page.mouse.down();
await page.mouse.move(orbBox.x - 60, orbBox.y - 40, { steps: 4 });
const trailing = await page.locator("glance-orb .g-orb-button").evaluate((b) => b.style.transform);
await page.mouse.up();
await page.waitForTimeout(900);
const settledT = await page.locator("glance-orb .g-orb-button").evaluate((b) => b.style.transform);
check("the orb trails the cursor while dragged, then settles on it", trailing.includes("translate") && settledT === "", `while dragging: "${trailing}" · after: "${settledT}"`);
const breathing = await page.locator("glance-orb .g-orb-button").getAttribute("data-breathe");
console.log(`INFO  idle breathing on this page: ${breathing ? "on" : "off (page can't hold frame rate, or not idle)"}`);
// Put the orb back where it was for the next steps.
await sw.evaluate(() => chrome.storage.sync.set({ orbPosition: { right: 24, bottom: 24 } }));
await page.waitForTimeout(500);

// 5. Clicking the orb docks to the side panel.
await page.locator("glance-orb .g-orb-button").click();
await page.waitForTimeout(800);
const mode = await sw.evaluate(() => chrome.storage.sync.get("defaultMode").then((v) => v.defaultMode));
check("clicking the orb docks Glance", mode === "docked", `defaultMode=${mode}`);
await sw.evaluate(() => chrome.storage.sync.set({ defaultMode: "floating" }));
await page.waitForTimeout(500);

// 6. Reload the extension under the open tab: quiet shutdown and a refresh notice.
const highlightsBefore = await page.evaluate(() => CSS.highlights?.size ?? 0);
await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
await page.locator("glance-updated").waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
const notice = await page.evaluate(() => document.querySelector("glance-updated")?.shadowRoot?.querySelector(".n")?.textContent ?? "");
check("refresh notice appears", notice.includes("Glance was updated. Refresh this page to use it."), notice);
check("orb UI removed", (await page.locator("glance-orb").count()) === 0);
const highlightsAfter = await page.evaluate(() => CSS.highlights?.size ?? 0);
check("underlines cleared", highlightsAfter === 0, `highlights before ${highlightsBefore}, after ${highlightsAfter}`);
// Interact after the reload: nothing should fire or log.
await page.keyboard.down("Alt");
await page.keyboard.press("KeyG");
await page.keyboard.up("Alt");
await page.mouse.move(400, 400);
await page.waitForTimeout(4_000);
await page.screenshot({ path: `${out}/reload-notice.png`, clip: { x: 1360 - 420, y: 900 - 160, width: 420, height: 160 } });
check("no extension errors logged", extErrors.length === 0, extErrors.slice(0, 3).join(" | "));
// Playwright's Chromium leaves an unpacked extension disabled after runtime.reload(); real Chrome re-enables it.
const extPage = await ctx.newPage();
await extPage.goto("chrome://extensions");
await extPage.evaluate(() => new Promise((r) => chrome.management.getAll((all) => { const g = all.find((e) => e.name === "Glance"); chrome.management.setEnabled(g.id, true, r); })));
await extPage.close();
await page.waitForTimeout(1_500);
await page.locator("glance-updated").evaluate((h) => h.shadowRoot.querySelector("button.go").click());
await page.waitForLoadState("domcontentloaded");
await page.locator("glance-orb .g-orb").waitFor({ timeout: 20_000 }).catch(() => {});
check("Refresh brings Glance back", (await page.locator("glance-orb .g-orb").count()) === 1 && (await page.locator("glance-updated").count()) === 0);

await ctx.close();
process.exit(failures ? 1 : 0);
