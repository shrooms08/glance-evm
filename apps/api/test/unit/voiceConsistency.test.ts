/**
 * One voice, always (API side): a long reply is never cut off by a total time limit (only a stall ends it), and the
 * common lines are pre-recorded in the configured voice: a hit makes no Deepgram call, a new voice records them again,
 * and audio that another voice spoke is never kept. A fake Deepgram: no test touches the network.
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FIXED_LINES, LINES, SPOKEN_GREETING } from "@glance/core/persona";
import { EMPTY_PORTFOLIO } from "@glance/core/tone";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { deepgramSpeaker, SPEECH_STALL_MS, selectVoiceProviders } from "../../src/voice/providers.js";
import { PrerecordedLines } from "../../src/voice/prerecorded.js";
import { FAKE_PROVIDER_KEY } from "../support/fake-keys.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const baseEnv = { NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" };
const KEY = FAKE_PROVIDER_KEY;

afterEach(() => vi.useRealTimers());

/** A body that sends a chunk every `everyMs`, `count` times (or stops sending after `stallAfter` chunks). */
function slowBody(count: number, everyMs: number, stallAfter = Infinity) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (sent >= stallAfter) return new Promise<void>(() => {}); // never another byte
      await new Promise((r) => setTimeout(r, everyMs));
      c.enqueue(new Uint8Array([++sent]));
      if (sent >= count) c.close();
    },
  });
}

describe("a reply streams for as long as it takes", () => {
  it("no total limit: a 30-second reply (a chunk a second) arrives whole", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        throw new Error("aborted");
      });
      return new Response(slowBody(30, 1_000), { headers: { "content-type": "audio/mpeg" } });
    });
    const s = deepgramSpeaker({ apiKey: KEY, voice: "flux-sienna-en", fetch: fetchFn as unknown as typeof fetch });
    const got: number[] = [];
    // The stream is handed over once its first audio has arrived (an empty answer falls through first).
    const read = (async () => {
      const reader = (await s.stream!("A long reply.")).getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) got.push(r.value[0]!);
    })();
    await vi.advanceTimersByTimeAsync(31_000);
    await read;
    expect(got).toHaveLength(30);
  });

  it(`only a stall ends it: no bytes for ${SPEECH_STALL_MS / 1000}s errors the stream (the page then stops, in the same voice)`, async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = slowBody(10, 100, 2);
      const r = new Response(body, { headers: { "content-type": "audio/mpeg" } });
      init?.signal?.addEventListener("abort", () => void body.cancel().catch(() => {}));
      return r;
    });
    const s = deepgramSpeaker({ apiKey: KEY, voice: "flux-sienna-en", fetch: fetchFn as unknown as typeof fetch });
    const outcome = (async () => {
      try {
        const reader = (await s.stream!("hi")).getReader();
        for (let r = await reader.read(); !r.done; r = await reader.read());
        return "ended";
      } catch {
        return "errored";
      }
    })();
    await vi.advanceTimersByTimeAsync(SPEECH_STALL_MS + 500);
    // The request is aborted and the stream errors: the page stops speaking (it never hangs, never switches voice).
    expect(await Promise.race([outcome, new Promise((r) => setTimeout(() => r("hung"), 1))])).toBe("errored");
  });
});

describe("pre-recorded common lines", () => {
  it("covers the lines with no values in them: the greeting, the advice decline, the refusal, errors and empty states", () => {
    for (const line of [SPOKEN_GREETING(), LINES.noAdvice, LINES.wontTrade, LINES.cantThink, LINES.outOfThinking, EMPTY_PORTFOLIO]) expect(FIXED_LINES).toContain(line);
    expect(FIXED_LINES.some((l) => /\$\d/.test(l) && !l.includes("buy $10 of Tesla"))).toBe(false); // no prices or amounts
    expect(SPOKEN_GREETING()).toContain("Tap Option G to glance, hold Option V to talk.");
  });

  function chain(voice = "flux-sienna-en") {
    const speakDetailed = vi.fn(async (text: string) => ({ audio: new Uint8Array([text.length % 250]), mime: "audio/mpeg", voice }));
    return { speakDetailed };
  }

  it("a hit plays from the store with no Deepgram call, across restarts; a voice change records them again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glance-voice-"));
    const c1 = chain();
    const store = new PrerecordedLines("flux-sienna-en", FIXED_LINES, dir);
    expect(await store.warm(c1)).toBe(FIXED_LINES.length);
    expect(c1.speakDetailed).toHaveBeenCalledTimes(FIXED_LINES.length);
    expect(readdirSync(dir).filter((f) => f.endsWith(".mp3"))).toHaveLength(FIXED_LINES.length);

    const c2 = chain();
    const restarted = new PrerecordedLines("flux-sienna-en", FIXED_LINES, dir);
    expect(await restarted.audio(LINES.noAdvice, c2)).toMatchObject({ prerecorded: true, voice: "flux-sienna-en" });
    expect(await restarted.warm(c2)).toBe(0);
    expect(c2.speakDetailed).not.toHaveBeenCalled();

    // A new voice: nothing matches (the key includes the voice), so every line is recorded again in it.
    const c3 = chain("aura-2-harmonia-en");
    const newVoice = new PrerecordedLines("aura-2-harmonia-en", FIXED_LINES, dir);
    expect(await newVoice.audio(LINES.wontTrade, c3)).toMatchObject({ prerecorded: false });
    expect(c3.speakDetailed).toHaveBeenCalledWith(LINES.wontTrade);
  });

  it("audio another voice spoke (a fall-through) is played but never kept", async () => {
    const store = new PrerecordedLines("flux-sienna-en", FIXED_LINES, null);
    const fellThrough = chain("aura-2-harmonia-en");
    expect(await store.audio(LINES.noAdvice, fellThrough)).toMatchObject({ prerecorded: false, voice: "aura-2-harmonia-en" });
    expect(store.get(LINES.noAdvice)).toBeNull();
    const fixed = chain("flux-sienna-en");
    await store.audio(LINES.noAdvice, fixed);
    expect(store.get(LINES.noAdvice)).not.toBeNull();
  });

  it("/voice/speak serves a pre-recorded line (no Deepgram call) and records the decision; a line with a price is live", async () => {
    const ctx = createContext(loadConfig({ ...baseEnv, DEEPGRAM_API_KEY: KEY }), () => {});
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([9, 9]), { headers: { "content-type": "audio/mpeg" } }));
    ctx.voice = selectVoiceProviders(loadConfig({ ...baseEnv, DEEPGRAM_API_KEY: KEY }), { fetch: fetchFn as unknown as typeof fetch, log: () => {} });
    ctx.prerecorded = new PrerecordedLines("flux-sienna-en", FIXED_LINES, null);
    const app = createApp(ctx);
    const get = (text: string) => app.request(`/voice/speak?text=${encodeURIComponent(text)}`);

    const first = await get(LINES.noAdvice);
    expect(first.headers.get("x-voice-cache")).toBe("generated");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const again = await get(LINES.noAdvice);
    expect(again.headers.get("x-voice-cache")).toBe("prerecorded");
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
    expect(fetchFn).toHaveBeenCalledTimes(1); // the hit made no Deepgram call
    expect(ctx.voice.decisions.list().at(-1)).toMatchObject({ source: "prerecorded", voice: "flux-sienna-en", firstByteMs: null });

    const priced = await get("Tesla is at $375.81.");
    expect(priced.headers.get("x-voice-cache")).toBe("miss");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("the in-memory phrase cache is keyed by the voice that spoke", () => {
  it("a phrase that fell through to Harmonia is played but never cached or replayed; Sienna's is", async () => {
    let fluxDown = true;
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL) => {
      const which = String(url).includes("/v2/speak") ? "flux" : "aura";
      calls.push(which);
      if (which === "flux" && fluxDown) return new Response("no", { status: 429 });
      return new Response(new Uint8Array([which === "flux" ? 1 : 2]), { headers: { "content-type": "audio/mpeg" } });
    });
    const v = selectVoiceProviders(loadConfig({ ...baseEnv, DEEPGRAM_API_KEY: KEY }), { fetch: fetchFn as unknown as typeof fetch, log: () => {} });
    const phrase = "Tesla is at $375.81.";
    expect([...(await v.tts!.speak(phrase)).audio]).toEqual([2]); // Harmonia, after Flux twice
    expect(v.tts!.has(phrase)).toBe(false); // not kept
    fluxDown = false;
    calls.length = 0;
    expect([...(await v.tts!.speak(phrase)).audio]).toEqual([1]); // asked again: Sienna, not the cached Harmonia
    expect(calls).toEqual(["flux"]);
    expect(v.tts!.has(phrase)).toBe(true);
    calls.length = 0;
    expect([...(await v.tts!.speak(phrase)).audio]).toEqual([1]);
    expect(calls).toEqual([]); // Sienna's copy is replayed
    // The stream path too: a fall-through stream isn't kept.
    fluxDown = true;
    const other = "Another short phrase.";
    const r = (await v.tts!.stream!(other)).getReader();
    while (!(await r.read()).done);
    expect(v.tts!.has(other)).toBe(false);
  });
});
