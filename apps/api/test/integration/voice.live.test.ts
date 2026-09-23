/**
 * Real Deepgram and Fish Audio calls, with latency printed. Skipped cleanly unless DEEPGRAM_API_KEY / FISH_API_KEY are
 * real keys (placeholders count as missing). Never trades.
 *   pnpm --filter api test:integration
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";

import { deepgram, fish, looksLikePlaceholder } from "../../src/voice/providers.js";

// Only the voice variables, read from apps/api/.env (if present) over the process environment, into a local object:
// nothing else in the environment changes for other tests (e.g. the agent key stays unloaded).
const dotenv = resolve(import.meta.dirname, "../../.env");
const fromFile = existsSync(dotenv) ? parseEnv(readFileSync(dotenv, "utf8")) : {};
const pick = (k: string) => process.env[k] || fromFile[k] || undefined;
const env = Object.fromEntries(
  ["DEEPGRAM_API_KEY", "DEEPGRAM_MODEL", "FISH_API_KEY", "FISH_MODEL", "FISH_VOICE_ID", "FISH_LATENCY"].map((k) => [k, pick(k)]),
) as Record<string, string | undefined>;
const wav = readFileSync(resolve(import.meta.dirname, "../fixtures/buy-ten-dollars-of-tesla.wav"));
const haveDeepgram = !looksLikePlaceholder(env.DEEPGRAM_API_KEY);
const haveFish = !looksLikePlaceholder(env.FISH_API_KEY);

describe.skipIf(!haveDeepgram)("Deepgram (live provider)", () => {
  const dg = deepgram({ apiKey: env.DEEPGRAM_API_KEY!, model: env.DEEPGRAM_MODEL ?? "nova-3" });

  it("transcribes a short command (pre-recorded)", async () => {
    const t0 = performance.now();
    const t = await dg.transcribe(wav, "audio/wav", ["Tesla", "TSLA"]);
    console.info(`[latency] deepgram pre-recorded ${Math.round(performance.now() - t0)}ms: "${t.text}" (${t.confidence})`);
    expect(t.text.toLowerCase()).toMatch(/tesla/);
    expect(t.confidence).toBeGreaterThan(0.5);
  });

  it("transcribes while streaming, and returns quickly after the user lets go", async () => {
    const live = dg.stream(["Tesla", "TSLA"]);
    for (let i = 0; i < wav.length; i += 3_200) {
      live.send(wav.subarray(i, i + 3_200));
      await new Promise((r) => setTimeout(r, 20)); // roughly real time
    }
    const released = performance.now();
    const t = await live.finish();
    console.info(`[latency] deepgram live: transcript ${Math.round(performance.now() - released)}ms after release: "${t.text}"`);
    expect(t.text.toLowerCase()).toMatch(/tesla/);
  });
});

describe.skipIf(!haveFish)("Fish Audio (live provider)", () => {
  it("speaks a short reply in the configured voice", async () => {
    const f = fish({
      apiKey: env.FISH_API_KEY!,
      model: env.FISH_MODEL ?? "s2.1-pro",
      voice: env.FISH_VOICE_ID ?? "790560d72d4d455ba0464995cd534f27",
      latency: (env.FISH_LATENCY as "balanced") ?? "balanced",
    });
    const t0 = performance.now();
    const out = await f.speak("Tesla is at $380. The market's open.");
    console.info(`[latency] fish ${Math.round(performance.now() - t0)}ms, ${out.audio.byteLength} bytes`);
    expect(out.mime).toBe("audio/mpeg");
    expect(out.audio.byteLength).toBeGreaterThan(1_000);
  });
});

describe.skipIf(haveDeepgram && haveFish)("voice providers not configured", () => {
  it("skips the live voice tests (set real DEEPGRAM_API_KEY and FISH_API_KEY in apps/api/.env to run them)", () => {
    expect(haveDeepgram && haveFish).toBe(false);
  });
});
