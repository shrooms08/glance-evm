// Voice plumbing check in real Chromium: push-to-talk on a page whose Permissions-Policy blocks the microphone must
// still reach Glance's offscreen document, and the orb must show the real reason when something is missing.
// Playwright's Chromium has no Google speech service, so the final step expects the "no speech service" sentence;
// in Google Chrome the same steps produce a transcript instead.
// Usage: pnpm build && node e2e/voice.mjs [outDir]
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const out = resolve(process.argv[2] || "e2e/out");
mkdirSync(out, { recursive: true });
const ext = resolve(".output/chrome-mv3");
// Phase 1 runs with no microphone permission. Phase 2 relaunches with Chromium's fake permission UI, which answers
// "Allow" (headless Chromium can't show the real prompt, and Playwright can't grant permissions to extension origins).
async function launch(allowMic) {
  const args = [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--use-fake-device-for-media-stream"];
  if (allowMic) args.push("--use-fake-ui-for-media-stream");
  const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: { width: 1200, height: 800 }, args });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  for (const p of ctx.pages()) if (p.url().includes("options.html")) await p.close();
  // A page that forbids the microphone outright, like many news sites.
  await ctx.route("https://blocked-mic.example/**", (r) =>
    r.fulfill({ status: 200, headers: { "content-type": "text/html", "permissions-policy": "microphone=()" }, body: "<h1>Tesla and Amazon report</h1><p>Tesla shares rose.</p>" }),
  );
  const page = await ctx.newPage();
  await page.goto("https://blocked-mic.example/");
  await page.locator("glance-orb .g-orb").waitFor({ timeout: 15_000 });
  return { ctx, page, id: new URL(sw.url()).host };
}

let { ctx, page, id } = await launch(false);

async function holdToTalk(ms) {
  await page.keyboard.down("Alt");
  await page.keyboard.down("KeyG");
  await page.waitForTimeout(ms);
  const during = await page.locator("glance-orb .g-orb").first().getAttribute("data-state");
  await page.keyboard.up("KeyG");
  await page.keyboard.up("Alt");
  return during;
}
const orbLine = async () => (await page.locator("glance-orb .g-root").innerText()).replace(/\n+/g, " | ");

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
};

// 1. Not enabled yet: the offscreen document reports it (a page-side attempt would have said "not-allowed").
await holdToTalk(600);
await page.getByText("I need microphone access").first().waitFor({ timeout: 10_000 }).catch(() => {});
let line = await orbLine();
check("before Enable voice: accurate sentence", line.includes("Click “Enable voice” in Glance's settings"), line);
check("typing still offered", await page.locator('glance-orb input[aria-label="Ask Glance"]').isVisible());

await ctx.close();

// 2. Settings with the microphone allowed: granted state and the diagnostics block.
({ ctx, page, id } = await launch(true));
const options = await ctx.newPage();
await options.goto(`chrome-extension://${id}/options.html`);
await options.locator('dl[aria-label="Voice diagnostics"]').waitFor();
const enable = options.getByRole("button", { name: "Enable voice" });
if (await enable.isVisible().catch(() => false)) await enable.click();
await options.getByRole("button", { name: "Voice enabled" }).waitFor({ timeout: 10_000 });
const diag = (await options.locator('dl[aria-label="Voice diagnostics"]').innerText()).replace(/\n+/g, " | ");
check("settings shows granted state and diagnostics", diag.includes("granted to Glance"), diag);
await options.screenshot({ path: `${out}/voice-settings.png`, fullPage: true });
await options.close();

// 3. Hold to talk again: listening starts in the offscreen document despite the page's policy.
await page.bringToFront();
const during = await holdToTalk(1_500);
check("orb is listening while the key is held", during === "listening", `data-state=${during}`);
await page.waitForTimeout(3_000);
line = await orbLine();
check(
  "after release: transcript or an accurate speech-service sentence",
  /no speech service|didn't hear anything|couldn't reach its speech service|Heard|“/.test(line),
  line,
);
await page.screenshot({ path: `${out}/voice-page.png` });

await ctx.close();
process.exit(failures ? 1 : 0);
