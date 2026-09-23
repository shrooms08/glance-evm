// Server-side voice, end to end in a real browser: hold Option+V on a page, speak (a fake microphone plays a WAV),
// release, and watch the orb go listening -> thinking -> speaking -> idle. Prints the measured latency from release.
// Usage: pnpm build && node e2e/voice-server.mjs [chromium|brave|arc] [apiUrl] [micWav]
//   The API must be running (for a keyless run: VOICE_PROVIDERS=fake PORT=8797 pnpm --filter api dev).
//   Pass an unreachable apiUrl (e.g. http://localhost:9) to check the fallback message instead.
import { resolve } from "node:path";
import { chromium } from "playwright";

const browserName = process.argv[2] ?? "chromium";
const api = process.argv[3] ?? "http://localhost:8797";
const wav = resolve(process.argv[4] ?? "../api/test/fixtures/buy-ten-dollars-of-tesla.wav");
const executables = {
  brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  arc: "/Applications/Arc.app/Contents/MacOS/Arc",
};
const ext = resolve(".output/chrome-mv3");
const ctx = await chromium.launchPersistentContext("", {
  ...(browserName === "chromium" ? { channel: "chromium" } : { executablePath: executables[browserName] }),
  headless: true,
  viewport: { width: 1200, height: 800 },
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
await sw.evaluate((a) => chrome.storage.sync.set({ apiBaseUrl: a, defaultMode: "floating" }), api);
for (const p of ctx.pages()) if (p.url().includes("options.html")) await p.close();
await ctx.route("https://news.example/**", (r) =>
  r.fulfill({ status: 200, headers: { "content-type": "text/html" }, body: "<h1>Tesla shares rise</h1><p>Tesla and Amazon gained on Friday.</p>" }),
);
const page = await ctx.newPage();
await page.goto("https://news.example/");
await page.locator("glance-orb .g-orb").waitFor({ timeout: 15_000 });
const ua = await page.evaluate(() => navigator.userAgent);
const brave = await page.evaluate(() => Boolean(navigator.brave));
console.log(`browser: ${browserName}${brave ? " (navigator.brave present)" : ""} · ${ua.match(/Chrome\/[\d.]+/)?.[0]} · api ${api}`);
await page.waitForTimeout(2_000);

const snap = () =>
  page.evaluate(() => {
    const r = document.querySelector("glance-orb")?.shadowRoot;
    return {
      state: r?.querySelector(".g-orb-button .g-orb")?.getAttribute("data-state") ?? "?",
      line: r?.querySelector(".g-panel .g-body")?.textContent ?? "",
      meta: r?.querySelector(".g-panel .g-data")?.textContent ?? "",
      latency: r?.querySelector("[data-voice-latency]")?.getAttribute("data-voice-latency") ?? null,
    };
  });

for (let round = 1; round <= 3; round++) {
  await page.keyboard.down("Alt");
  await page.keyboard.down("KeyV");
  const held = Date.now();
  const during = [];
  while (Date.now() - held < 1_800) {
    during.push((await snap()).state);
    await page.waitForTimeout(40);
  }
  await page.keyboard.up("KeyV");
  await page.keyboard.up("Alt");
  const released = Date.now();
  const after = [];
  let last;
  while (Date.now() - released < 7_000) {
    last = await snap();
    const prev = after.at(-1);
    if (!prev || prev.state !== last.state) after.push({ t: Date.now() - released, state: last.state });
    if (last.state === "idle" && after.some((a) => a.state === "speaking")) break;
    await page.waitForTimeout(20);
  }
  const speakingAt = after.find((a) => a.state === "speaking")?.t;
  console.log(`round ${round}: while held ${[...new Set(during)].join(" -> ")}; after release ${after.map((a) => `${a.state}@${a.t}ms`).join(" -> ")}`);
  console.log(`         panel: "${last.line}" · ${last.meta}`);
  console.log(`         measured in the extension: ${last.latency ?? "(no timing: fallback or error)"}${speakingAt !== undefined ? ` · orb speaking ${speakingAt}ms after release (seen from the page)` : ""}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1_500);
}
await ctx.close();
