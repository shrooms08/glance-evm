/**
 * Gapless playback of a reply in sentences (lib/gapless.ts, and the worker's Web Audio path): back-to-back start
 * times, prefetching N+1 and N+2, fades at the edges, one voice per answer when the first one fails, and Escape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LINES } from "@glance/core/persona";
import { FADE_S, mp3FrameEnd, START_BUFFER_S, Timeline, webAudioOut, type AudioOut, type Decoded } from "../lib/gapless";
import type { SpeechEvent } from "../lib/voiceMessages";
import { FALLBACK_BUDGET_MS, VoiceWorker, type WorkerDeps } from "../lib/voiceWorker";

const API = "http://localhost:8790";
const PRIMARY = "flux-sienna-en";
const FALLBACK = "aura-2-harmonia-en";

describe("Timeline", () => {
  it("starts the first sentence after the start buffer, and each next one exactly where the last one ends", () => {
    const t = new Timeline();
    const a = t.place(10, 2);
    expect(a.start).toBeCloseTo(10 + START_BUFFER_S);
    const b = t.place(10.5, 3); // ready long before a ends
    expect(b.start).toBe(a.end);
    expect(b.gap).toBe(0);
    const c = t.place(12, 1);
    expect(c.start).toBe(b.end);
    expect(c.late).toBe(false);
  });

  it("a sentence ready after the last one ended is late: it starts as soon as it can, and the gap is counted", () => {
    const t = new Timeline(0.2, 0.02);
    const a = t.place(0, 1); // 0.2 to 1.2
    const b = t.place(1.5, 1);
    expect(b.late).toBe(true);
    expect(b.start).toBeCloseTo(1.52);
    expect(b.gap).toBeCloseTo(1.52 - a.end);
  });

  it("the start buffer is 150 to 250ms", () => {
    expect(START_BUFFER_S).toBeGreaterThanOrEqual(0.15);
    expect(START_BUFFER_S).toBeLessThanOrEqual(0.25);
  });
});

describe("webAudioOut", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fades each sentence in and out over 3 to 5ms, starts it at the exact time, and opens the context at the speech's rate", () => {
    const ramps: Array<[string, number, number]> = [];
    const started: number[] = [];
    let opened: AudioContextOptions | undefined;
    class FakeContext {
      currentTime = 0;
      sampleRate: number;
      destination = {};
      constructor(o?: AudioContextOptions) {
        opened = o;
        this.sampleRate = o?.sampleRate ?? 48_000;
      }
      resume = () => Promise.resolve();
      createBufferSource() {
        return { buffer: null, connect: (n: unknown) => n, start: (at: number) => started.push(at), stop() {}, disconnect() {} };
      }
      createGain() {
        const gain = {
          setValueAtTime: (v: number, at: number) => ramps.push(["set", v, at]),
          linearRampToValueAtTime: (v: number, at: number) => ramps.push(["ramp", v, at]),
        };
        return { gain, connect: (n: unknown) => n };
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);
    const out = webAudioOut(24_000);
    expect(opened?.sampleRate).toBe(24_000);
    expect(out.sampleRate).toBe(24_000);
    out.play({ duration: 2 } as AudioBuffer, 5, { in: FADE_S, out: FADE_S });
    expect(started).toEqual([5]);
    expect(FADE_S).toBeGreaterThanOrEqual(0.003);
    expect(FADE_S).toBeLessThanOrEqual(0.005);
    expect(ramps).toEqual([
      ["set", 0, 5],
      ["ramp", 1, 5 + FADE_S],
      ["set", 1, 7 - FADE_S],
      ["ramp", 0, 7],
    ]);
    // A slice inside a sentence: no fades, so its joins are seamless.
    ramps.length = 0;
    out.play({ duration: 1 } as AudioBuffer, 7, { in: 0, out: 0 });
    expect(ramps).toEqual([["set", 1, 7]]);
  });
});

describe("mp3FrameEnd", () => {
  // MPEG 2 layer III, 24kHz, 48kbps: 72000 * 48 / 24000 = 144 bytes a frame.
  const frame = () => {
    const f = new Uint8Array(144);
    f.set([0xff, 0xf3, 0x64, 0xc4]);
    return f;
  };
  it("finds where the last whole frame ends, so a sentence still arriving is decoded to a frame boundary", () => {
    const bytes = new Uint8Array(144 * 3 + 50);
    for (let i = 0; i < 3; i++) bytes.set(frame(), i * 144);
    bytes.set(frame().subarray(0, 50), 432);
    expect(mp3FrameEnd(bytes)).toBe(432);
    expect(mp3FrameEnd(bytes.subarray(0, 100))).toBe(0);
  });
  it("is null for bytes that aren't MP3", () => {
    expect(mp3FrameEnd(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
  });
});

// ---- The worker's Web Audio path, on a fake output whose clock is the (fake) wall clock ----------------------------

interface Played {
  at: number;
  duration: number;
  fade: { in: number; out: number };
  voice: string;
  stopped: boolean;
}

/** A clip that arrives in pieces: `pieces` of `bytes` each, `everyMs` apart. */
function trickle(first: number, pieces: number, bytes: number, everyMs: number) {
  let n = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (n > 0) await new Promise((r) => setTimeout(r, everyMs));
      const b = new Uint8Array(bytes).fill(7);
      if (n === 0) b[0] = first;
      c.enqueue(b);
      if (++n === pieces) c.close();
    },
  });
}

function setup(o: { speak?: (url: string) => Promise<Response> | Response | undefined } = {}) {
  const events: SpeechEvent[] = [];
  const speakUrls: string[] = [];
  const played: Played[] = [];
  const outs: Array<{ closed: boolean }> = [];
  const base = Date.now();
  const clock = () => (Date.now() - base) / 1000;
  // A clip's bytes: one byte a sample at 100 a second (200 bytes: 2s), its first byte which voice said it.
  const voices = [PRIMARY, FALLBACK];
  const clip = (voice: string, samples = 200) => new Uint8Array([voices.indexOf(voice), ...new Array(samples - 1).fill(7)]);
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/voice/status")) return Response.json({ available: { speech: true }, speechChain: [{ voice: PRIMARY }, { voice: FALLBACK }] });
    if (u.includes("/voice/speak?")) {
      speakUrls.push(decodeURIComponent(u));
      const own = await o.speak?.(u);
      if (own) return own;
      const voice = new URL(u).searchParams.get("voice") || PRIMARY;
      return new Response(clip(voice), { headers: { "content-type": "audio/mpeg", "x-voice": voice, "x-voice-cache": "miss" } });
    }
    throw new Error(`unexpected ${u}`);
  });
  const audioOut = (): AudioOut => {
    const state = { closed: false };
    outs.push(state);
    return {
      get currentTime() {
        return clock();
      },
      sampleRate: 100,
      decode: async (bytes) => {
        const b = new Uint8Array(bytes);
        return { duration: b.length / 100, length: b.length, sampleRate: 100, voice: voices[b[0]!] } as Decoded;
      },
      slice: (buffer, from, to) => ({ ...buffer, duration: (to - from) / 100, length: to - from }),
      play(buffer, at, fade) {
        const p: Played = { at, duration: buffer.duration, fade, voice: (buffer as Decoded & { voice: string }).voice, stopped: false };
        played.push(p);
        return { stop: () => void (p.stopped = true) };
      },
      close: () => void (state.closed = true),
    };
  };
  const deps = {
    fetch: fetchFn as unknown as typeof fetch,
    WebSocket: class {} as never,
    getUserMedia: async () => ({}) as MediaStream,
    capturePcm: async () => ({ stop: async () => {} }),
    createAudio: () => {
      throw new Error("the element player isn't used for a reply in sentences");
    },
    audioOut,
    micFailed: async () => "mic-denied" as never,
    micWorked: () => {},
    listen: () => null,
    errorTone: vi.fn(),
    objectUrl: () => "blob:clip",
    emit: (e) => events.push(e as SpeechEvent),
    now: () => Date.now(),
  } satisfies WorkerDeps;
  const worker = new VoiceWorker(deps);
  const types = () => events.filter((e) => e.kind === "voice:speech" && e.type !== "part-progress" && e.type !== "report").map((e) => e.type);
  const report = () => (events.find((e) => e.type === "report") as Extract<SpeechEvent, { type: "report" }> | undefined)?.report;
  return { worker, events, speakUrls, played, outs, types, report, errorTone: deps.errorTone };
}

describe("voice worker: a reply in sentences, gapless", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval", "clearTimeout", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("schedules each sentence to start exactly where the one before it ends, with fades, in one context", async () => {
    const t = setup();
    t.worker.speakPart("a", 0, "Revenue grew twelve percent.", API);
    t.worker.speakPart("a", 1, "The margin was eighteen percent.", API);
    t.worker.speakPart("a", 2, "Deliveries were a record.", API);
    t.worker.speakEnd("a", 3);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(t.played).toHaveLength(3);
    for (let i = 1; i < 3; i++) expect(t.played[i]!.at).toBeCloseTo(t.played[i - 1]!.at + t.played[i - 1]!.duration, 9);
    expect(t.played.every((p) => p.fade.in === FADE_S && p.fade.out === FADE_S)).toBe(true);
    expect(t.outs).toHaveLength(1);
    expect(t.outs[0]!.closed).toBe(true);
    expect(t.types()).toEqual(["start", "part", "part-end", "part", "part-end", "part", "part-end", "end"]);
    const r = t.report()!;
    expect(r).toMatchObject({ player: "webaudio", breaks: 0, underruns: 0, voiceChanges: 0, outcome: "ended" });
    expect(r.gaps).toEqual([0, 0]);
  });

  it("fetches the next two sentences while one plays, and no further", async () => {
    const t = setup();
    for (let i = 0; i < 6; i++) t.worker.speakPart("b", i, `Sentence ${i}.`, API);
    t.worker.speakEnd("b", 6);
    await vi.advanceTimersByTimeAsync(100); // before the first one has started
    expect(t.speakUrls.map((u) => u.match(/Sentence (\d)/)![1])).toEqual(["0", "1", "2"]);
    expect(t.speakUrls.slice(1).every((u) => u.endsWith(`&voice=${PRIMARY}`))).toBe(true);
    await vi.advanceTimersByTimeAsync(2_300); // sentence 1 is playing (each is 2s, from 0.2s)
    expect(t.speakUrls.map((u) => u.match(/Sentence (\d)/)![1])).toEqual(["0", "1", "2", "3"]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.played).toHaveLength(6);
    expect(t.report()).toMatchObject({ breaks: 0, underruns: 0 });
  });

  it("a sentence that comes late is an underrun and a gap in the report", async () => {
    const t = setup();
    t.worker.speakPart("c", 0, "One.", API);
    await vi.advanceTimersByTimeAsync(3_000); // one has played (0.2s to 2.2s), and two isn't written yet
    t.worker.speakPart("c", 1, "Two.", API);
    t.worker.speakEnd("c", 2);
    await vi.advanceTimersByTimeAsync(5_000);
    const r = t.report()!;
    expect(r.underruns).toBe(1);
    expect(r.breaks).toBe(1);
  });

  it("when the first voice fails partway, the remaining sentences are said in the fallback voice, and it never switches back", async () => {
    // The first voice answers the first sentence, then can't: every later request pinned to it fails.
    const t = setup({ speak: (u) => (u.includes(`&voice=${PRIMARY}`) ? new Response("", { status: 503 }) : undefined) });
    for (let i = 0; i < 4; i++) t.worker.speakPart("d", i, `Sentence ${i}.`, API);
    t.worker.speakEnd("d", 4);
    await vi.advanceTimersByTimeAsync(15_000);
    // Sentence 0 in the first voice; every slice after it in the fallback voice.
    const voicesInOrder = t.played.map((p) => p.voice).filter((v, i, all) => i === 0 || v !== all[i - 1]);
    expect(voicesInOrder).toEqual([PRIMARY, FALLBACK]);
    // Once on the fallback voice, nothing more is asked of the first one.
    const firstFallback = t.speakUrls.findIndex((u) => u.endsWith(`&voice=${FALLBACK}`));
    expect(t.speakUrls.slice(firstFallback).every((u) => u.endsWith(`&voice=${FALLBACK}`))).toBe(true);
    for (let i = 1; i < 4; i++) expect(t.played[i]!.at).toBeCloseTo(t.played[i - 1]!.at + t.played[i - 1]!.duration, 9);
    expect(t.types().at(-1)).toBe("end");
  });

  it("when the fallback can't be ready in time, the on-screen line follows in the answer's voice and the rest is shown", async () => {
    const slow = () => new Promise<Response>((res) => setTimeout(() => res(new Response(new Uint8Array(200).fill(1), { headers: { "x-voice": FALLBACK } })), FALLBACK_BUDGET_MS + 2_000));
    const t = setup({
      speak: (u) => {
        if (decodeURIComponent(u).includes(LINES.answerOnScreen)) return undefined;
        if (u.includes(`&voice=${PRIMARY}`)) return new Response("", { status: 503 });
        if (u.includes(`&voice=${FALLBACK}`)) return slow();
        return undefined;
      },
    });
    t.worker.speakPart("e", 0, "Tesla fell this week.", API);
    t.worker.speakPart("e", 1, "It dropped on Tuesday.", API);
    t.worker.speakEnd("e", 2);
    await vi.advanceTimersByTimeAsync(10_000);
    // The sentence, then the on-screen line (2s each), all in the answer's voice.
    expect(new Set(t.played.map((p) => p.voice))).toEqual(new Set([PRIMARY]));
    expect(t.played.reduce((s, p) => s + p.duration, 0)).toBeCloseTo(4, 9);
    expect(t.speakUrls.at(-1)).toBe(`${API}/voice/speak?text=${LINES.answerOnScreen}&voice=${PRIMARY}`);
    expect(t.events.filter((e) => e.type !== "report").at(-1)).toMatchObject({ type: "cut", part: 1 });
    expect(t.report()).toMatchObject({ voiceChanges: 0, outcome: "on-screen" });
    expect(t.errorTone).not.toHaveBeenCalled();
  });

  it("a long sentence starts playing before it has all arrived, its slices back to back with no fade between them", async () => {
    // 4s of sound arriving over 1.5s: faster than it plays, but it starts on the first piece.
    const t = setup({ speak: (u) => (u.includes("Long") ? new Response(trickle(0, 4, 100, 500), { headers: { "x-voice": PRIMARY } }) : undefined) });
    t.worker.speakPart("g", 0, "Long.", API);
    t.worker.speakPart("g", 1, "Short.", API);
    t.worker.speakEnd("g", 2);
    await vi.advanceTimersByTimeAsync(600);
    expect(t.played.length).toBeGreaterThan(0); // playing while the rest arrives
    await vi.advanceTimersByTimeAsync(10_000);
    for (let i = 1; i < t.played.length; i++) expect(t.played[i]!.at).toBeCloseTo(t.played[i - 1]!.at + t.played[i - 1]!.duration, 9);
    const long = t.played.slice(0, -1);
    expect(long.reduce((s, p) => s + p.duration, 0)).toBeCloseTo(4, 9);
    expect(long[0]!.fade.in).toBe(FADE_S);
    expect(long.slice(1).every((p) => p.fade.in === 0)).toBe(true);
    expect(long.slice(0, -1).every((p) => p.fade.out === 0)).toBe(true);
    expect(long.at(-1)!.fade.out).toBe(FADE_S);
    expect(t.report()).toMatchObject({ breaks: 0, underruns: 0, outcome: "ended" });
  });

  it("a sentence arriving slower than it plays runs dry: the underrun and its gap are in the report", async () => {
    // 50 samples (0.5s) every 1.5s.
    const t = setup({ speak: () => new Response(trickle(0, 4, 50, 1_500), { headers: { "x-voice": PRIMARY } }) });
    t.worker.speakPart("h", 0, "Slow.", API);
    t.worker.speakEnd("h", 1);
    await vi.advanceTimersByTimeAsync(10_000);
    const r = t.report()!;
    expect(r.underruns).toBeGreaterThan(0);
    expect(r.breaks).toBeGreaterThan(0);
    expect(r.innerGaps.length).toBeGreaterThan(0);
  });

  it("a single reply (speak) plays through the same gapless player: start, progress, end, then its report", async () => {
    const t = setup();
    const started = vi.fn();
    const done = t.worker.speak("s", "Tesla is at $412, up 2% today on delivery numbers.", API, started);
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(started).toHaveBeenCalledOnce();
    const seen = t.events.map((e) => e.type).filter((type, i, all) => type !== all[i - 1]);
    expect(seen).toEqual(["start", "progress", "end", "report"]);
    expect(t.report()).toMatchObject({ player: "webaudio", breaks: 0, underruns: 0, outcome: "ended" });
  });

  it("a reply pushed all at once, its end arriving before its parts, still plays through and ends", async () => {
    const t = setup();
    t.worker.speakEnd("k", 3);
    for (let i = 0; i < 3; i++) t.worker.speakPart("k", i, `Sentence ${i}.`, API);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.played).toHaveLength(3);
    expect(t.types().at(-1)).toBe("end");
    expect(t.report()).toMatchObject({ outcome: "ended", sentences: 3, breaks: 0 });
  });

  it("Escape stops every scheduled sentence at once and asks for nothing more", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) t.worker.speakPart("f", i, `Sentence ${i}.`, API);
    await vi.advanceTimersByTimeAsync(500);
    expect(t.played.length).toBeGreaterThan(1);
    const asked = t.speakUrls.length;
    t.worker.hush();
    expect(t.played.every((p) => p.stopped)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.speakUrls).toHaveLength(asked);
    expect(t.outs[0]!.closed).toBe(true);
    expect(t.types()).not.toContain("part-end");
  });
});
