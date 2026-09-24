/**
 * Real Deepgram and Fish Audio calls, with a latency breakdown printed. Skipped cleanly unless the keys are real
 * (placeholders count as missing). Never trades.   pnpm --filter api test:integration
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { deepgram, deepgramSpeaker, fish, looksLikePlaceholder, ProviderError, withFallThrough, type Speaker } from "../../src/voice/providers.js";

// Only the voice variables, read from apps/api/.env (if present) over the process environment, into a local object:
// nothing else in the environment changes for other tests (e.g. the agent key stays unloaded).
const dotenv = resolve(import.meta.dirname, "../../.env");
const fromFile = existsSync(dotenv) ? parseEnv(readFileSync(dotenv, "utf8")) : {};
const pick = (k: string) => process.env[k] || fromFile[k] || undefined;
const env = Object.fromEntries(
  ["DEEPGRAM_API_KEY", "DEEPGRAM_MODEL", "DEEPGRAM_TTS_VOICE", "FISH_API_KEY", "FISH_MODEL", "FISH_VOICE_ID", "FISH_LATENCY"].map((k) => [k, pick(k)]),
) as Record<string, string | undefined>;
const haveDeepgram = !looksLikePlaceholder(env.DEEPGRAM_API_KEY);
const haveFish = !looksLikePlaceholder(env.FISH_API_KEY);

const wavFile = readFileSync(resolve(import.meta.dirname, "../fixtures/buy-ten-dollars-of-tesla.wav"));
const pcm = wavFile.subarray(44); // 16kHz mono 16-bit, as the extension now streams
const report: string[] = [];
const line = (s: string) => report.push(s);
afterAll(() => {
  const text = `\n[latency breakdown, from this machine]\n${report.map((r) => `  ${r}`).join("\n")}\n`;
  console.info(text);
  // VOICE_LATENCY_REPORT=<file>: also written there (the test runner may not show console output).
  if (process.env.VOICE_LATENCY_REPORT) writeFileSync(process.env.VOICE_LATENCY_REPORT, text);
});

const ms = (n: number) => `${Math.round(n)}ms`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** TCP connect time: one network round trip, the floor under every request. */
function rtt(host: string): Promise<number> {
  return new Promise((done, fail) => {
    const t0 = performance.now();
    const s = connect(443, host, () => {
      done(performance.now() - t0);
      s.destroy();
    });
    s.on("error", fail);
  });
}

/** Streams the fixture in real time (40ms slices, as the extension does), then "releases". */
async function speakInto(live: { send(c: Uint8Array): void }) {
  for (let i = 0; i < pcm.length; i += 1_280) {
    live.send(pcm.subarray(i, i + 1_280));
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe.skipIf(!haveDeepgram)("network round trip", () => {
  it("measures it (TCP connect, best of 5)", async () => {
    for (const host of ["api.deepgram.com", ...(haveFish ? ["api.fish.audio"] : [])]) {
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) samples.push(await rtt(host));
      line(`round trip to ${host}: ${ms(Math.min(...samples))} best, ${ms(median(samples))} median`);
    }
  });
});

describe.skipIf(!haveDeepgram)("Deepgram transcription (live provider)", () => {
  const dg = deepgram({ apiKey: env.DEEPGRAM_API_KEY!, model: env.DEEPGRAM_MODEL ?? "nova-3" });

  it("streaming: a new connection, then the warm one reused (Finalize on release)", async () => {
    const runs: Array<{ connect: number; warm: boolean; final: number; text: string }> = [];
    for (let i = 0; i < 4; i++) {
      const live = dg.stream(["Tesla", "TSLA"]);
      await speakInto(live);
      const t = await live.finish();
      runs.push({ connect: t.timing!.connectMs, warm: t.timing!.warm, final: t.timing!.releaseToFinalMs, text: t.text });
      expect(t.text.toLowerCase()).toMatch(/tesla/);
    }
    const [cold, ...warm] = runs;
    line(`transcription, new connection: connect ${ms(cold!.connect)} (overlaps speech: the key is down), release to final ${ms(cold!.final)} "${cold!.text}"`);
    line(`transcription, warm connection reused (${warm.length} runs): connect 0ms, release to final ${warm.map((w) => ms(w.final)).join(", ")} (median ${ms(median(warm.map((w) => w.final)))})`);
    expect(warm.every((w) => w.warm)).toBe(true);
  });

  it("pre-recorded upload (the fallback): cold, then on a kept-alive connection", async () => {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const t = await dg.transcribe(wavFile, "audio/wav", ["Tesla", "TSLA"]);
      times.push(performance.now() - t0);
      expect(t.text.toLowerCase()).toMatch(/tesla/);
    }
    line(`pre-recorded upload (fallback only): ${times.map(ms).join(", ")} (first includes the TLS handshake)`);
  });
});

/** Three short Glance replies, as spoken. */
const REPLIES = ["Tesla is at $242.18, and the market is open.", "You hold $119.92 across 1 stock, up $1.40 overall.", "Buying $10 of Tesla. Say yes to confirm."];
/** VOICE_LATENCY_BENCH=1: 5 runs of each reply per voice (the comparison behind the default voice); otherwise 1. */
const RUNS = process.env.VOICE_LATENCY_BENCH === "1" ? 5 : 1;

describe.skipIf(!haveDeepgram)("Deepgram speech, Aura vs Flux (live provider)", () => {
  it("time to first audio and total, per reply, median of runs", { timeout: 300_000 }, async () => {
    const voices = ["aura-2-athena-en", "flux-sienna-en"];
    const speakers = voices.map((voice) => deepgramSpeaker({ apiKey: env.DEEPGRAM_API_KEY!, voice }));
    const timeOne = async (s: Speaker, text: string, minBytes = 5_000) => {
      const t0 = performance.now();
      const reader = (await s.stream!(text)).getReader();
      let first = 0;
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!first) first = performance.now() - t0;
        bytes += value.byteLength;
      }
      expect(bytes).toBeGreaterThan(minBytes);
      return { first, total: performance.now() - t0 };
    };
    // Warm each endpoint's kept-alive connection first (the API pre-warms on key press), untimed.
    for (const s of speakers) await timeOne(s, "Okay.", 1_000);
    const results = speakers.map(() => REPLIES.map(() => ({ first: [] as number[], total: [] as number[] })));
    for (let run = 0; run < RUNS; run++) {
      for (const [r, text] of REPLIES.entries()) {
        for (const [v, s] of speakers.entries()) {
          const t = await timeOne(s, text); // alternating voices, so both see the same network
          results[v]![r]!.first.push(t.first);
          results[v]![r]!.total.push(t.total);
        }
      }
    }
    line(`speech, median of ${RUNS} run(s) per reply (first audio byte / complete):`);
    for (const [v, voice] of voices.entries()) {
      const rows = results[v]!.map((x) => `${ms(median(x.first))} / ${ms(median(x.total))}`);
      const all = results[v]!.flatMap((x) => x.first);
      line(`  ${voice.padEnd(17)} ${rows.join("   ")}   overall first byte ${ms(median(all))}`);
    }
  });
});

describe.skipIf(!haveFish)("Fish Audio speech (live provider)", () => {
  const f = () =>
    fish({
      apiKey: env.FISH_API_KEY!,
      model: env.FISH_MODEL ?? "s2.1-pro",
      voice: env.FISH_VOICE_ID ?? "790560d72d4d455ba0464995cd534f27",
      latency: (env.FISH_LATENCY as "balanced") ?? "balanced",
    });

  it("speaks, or reports exactly why it can't (402 = no API credit)", async () => {
    const t0 = performance.now();
    try {
      const out = await f().speak("Tesla is at $379.93.");
      line(`speech (Fish ${env.FISH_MODEL ?? "s2.1-pro"}): ${ms(performance.now() - t0)} complete, ${out.audio.byteLength} bytes`);
      expect(out.mime).toBe("audio/mpeg");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      line(`speech (Fish ${env.FISH_MODEL ?? "s2.1-pro"}): refused with ${(err as ProviderError).status} after ${ms(performance.now() - t0)}`);
    }
  });

  it.skipIf(!haveDeepgram)("with VOICE_TTS=fish, a refusal falls through to Deepgram for that reply", async () => {
    const warnings: string[] = [];
    const chain = withFallThrough(
      [f(), deepgramSpeaker({ apiKey: env.DEEPGRAM_API_KEY!, voice: env.DEEPGRAM_TTS_VOICE ?? "aura-2-athena-en" })] as Speaker[],
      (w) => warnings.push(w),
    );
    const t0 = performance.now();
    const out = await chain.speak("Tesla is at $379.93.");
    expect(out.audio.byteLength).toBeGreaterThan(5_000);
    line(`fish first, falling through: ${warnings[0] ?? "(Fish answered: no fall-through needed)"} (${ms(performance.now() - t0)} total)`);
  });
});

describe.skipIf(haveDeepgram)("voice providers not configured", () => {
  it("skips the live voice tests (set a real DEEPGRAM_API_KEY in apps/api/.env to run them)", () => {
    expect(haveDeepgram).toBe(false);
  });
});
