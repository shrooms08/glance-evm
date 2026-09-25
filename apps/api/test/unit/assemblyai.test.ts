/**
 * AssemblyAI Universal-Streaming against a fake AssemblyAI server (a real local WebSocket server speaking the v3
 * protocol: Begin, Turn partials and formatted finals, ForceEndpoint, Terminate/Termination, Error and 1008 closes).
 *
 *   adapter      the query (pcm_s16le 16kHz, model, format_turns, keyterms_prompt), the key only in the Authorization
 *                header, audio held until Begin and sent in 50-1000ms frames, partials, ForceEndpoint at the release,
 *                the end of a turn, a warm session taken over (keyterms brought up to date), Termination's seconds metered
 *   fall-through a refused key (1008), an unreachable server, no Begin in time: Deepgram hears the same audio, one log
 *                line; the daily AssemblyAI seconds used up: Deepgram listens; every provider's seconds: voice rests
 *   /voice/stream conversation mode (the end of the turn sends the transcript; the Deepgram fallback ends a turn on
 *                quiet), hold-to-talk unchanged (the transcript only at the release), the session's basket keyterms
 *   keyterms     tickers, names, Glance's words and verbs, within 100 terms of 50 characters
 * No network beyond 127.0.0.1, no real keys.
 */
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildKeyterms, KEYTERM_MAX, KEYTERM_MAX_CHARS, sessionKeyterms } from "@glance/core/keyterms";
import { VOICE_RESTING } from "@glance/core/session";

import { createServerApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { aaiError, assemblyai, MAX_FRAME_BYTES, MIN_FRAME_BYTES } from "../../src/voice/assemblyai.js";
import { DailyMeter } from "../../src/voice/dailyCaps.js";
import { selectVoiceProviders, withSttFallback, type LiveTranscription, type StreamHooks, type Transcriber } from "../../src/voice/providers.js";
import { keyterms } from "../../src/voice/routes.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const KEY = "aai0test0key0not0real0000000000000000000";

// ---------------------------------------------------------------------------------------------------------------------
// The fake AssemblyAI server.

interface Session {
  url: URL;
  auth: string | undefined;
  frames: Uint8Array[];
  messages: { type: string; [k: string]: unknown }[];
  ws: WSContext;
  /** The current turn's order, and whether it's still open (words heard since the last turn ended). */
  order: number;
  open: boolean;
  turn(text: string, o?: { order?: number; end?: boolean; formatted?: boolean }): void;
}
interface Behaviour {
  /** "ok" (Begin at once), "refuse" (close 1008 at the door), "busy" (1008 too many sessions), "silent" (no Begin). */
  open: "ok" | "refuse" | "busy" | "silent";
  /** Sent as a partial when the first audio frame arrives. */
  partial: string | null;
  /** The turn's formatted final, sent on ForceEndpoint (unformatted first, as Universal-Streaming does). */
  final: string;
  /** Billed seconds in Termination. */
  sessionSeconds: number;
}
const DEFAULT: Behaviour = { open: "ok", partial: "buy ten", final: "Buy $10 of Palantir.", sessionSeconds: 2.5 };

const sessions: Session[] = [];
let behaviour: Behaviour = { ...DEFAULT };
let aaiUrl = "";
let closeFake: () => void = () => {};

beforeAll(async () => {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  app.get(
    "/v3/ws",
    upgradeWebSocket((c) => {
      let s: Session;
      const send = (m: object) => s.ws.send(JSON.stringify(m));
      return {
        onOpen(_e, ws) {
          s = {
            url: new URL(c.req.url),
            auth: c.req.header("authorization"),
            frames: [],
            messages: [],
            ws,
            order: 0,
            open: false,
            turn: (text, o = {}) => {
              send({ type: "Turn", turn_order: o.order ?? s.order, transcript: text, end_of_turn: o.end ?? false, turn_is_formatted: o.formatted ?? false, words: [] });
              s.open = !(o.end && o.formatted);
              if (o.end && o.formatted) s.order++;
            },
          };
          sessions.push(s);
          const b = behaviour;
          if (b.open === "refuse") return ws.close(1008, "Invalid API key");
          if (b.open === "busy") return ws.close(1008, "Unauthorized connection: Too many concurrent sessions");
          if (b.open === "ok") send({ type: "Begin", id: `s${sessions.length}`, expires_at: 0, configuration: { speech_model: s.url.searchParams.get("speech_model") } });
        },
        onMessage(e) {
          if (typeof e.data !== "string") {
            const d = e.data as ArrayBuffer | Uint8Array;
            s.frames.push(d instanceof Uint8Array ? d : new Uint8Array(d));
            if (s.frames.length === 1 && behaviour.partial) s.turn(behaviour.partial);
            return;
          }
          const m = JSON.parse(e.data) as { type: string };
          s.messages.push(m);
          // Ends the turn in progress; with none (the last one already ended), there's nothing to send.
          if (m.type === "ForceEndpoint" && s.open) {
            s.turn(behaviour.final.replace(/[$.]/g, "").toLowerCase(), { end: true });
            s.turn(behaviour.final, { end: true, formatted: true });
          }
          if (m.type === "Terminate") {
            send({ type: "Termination", audio_duration_seconds: 1, session_duration_seconds: behaviour.sessionSeconds });
            s.ws.close(1000);
          }
        },
      };
    }),
  );
  const server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);
  await new Promise<void>((r) => server.once("listening", () => r()));
  aaiUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v3/ws`;
  closeFake = () => server.close();
});
afterAll(() => closeFake());
beforeEach(() => {
  sessions.length = 0;
  behaviour = { ...DEFAULT };
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
};
/** 40ms of 16kHz 16-bit mono, as the extension sends it. */
const slice = (fill = 1) => new Uint8Array(1_280).fill(fill);
const make = (o: { meter?: DailyMeter; beginTimeoutMs?: number; url?: string } = {}) =>
  assemblyai({ apiKey: KEY, model: "universal-3-5-pro", url: o.url ?? aaiUrl, meter: o.meter, beginTimeoutMs: o.beginTimeoutMs ?? 1_000, finishTimeoutMs: 1_000 });

// ---------------------------------------------------------------------------------------------------------------------

describe("AssemblyAI adapter (fake server)", () => {
  it("connects with our audio format, model, formatted turns and keyterms; the key only in the Authorization header", async () => {
    const live = make().stream(["Tesla", "TSLA", "Tech Giants"]);
    await until(() => sessions.length === 1);
    const s = sessions[0]!;
    expect(Object.fromEntries(s.url.searchParams)).toEqual({
      sample_rate: "16000",
      encoding: "pcm_s16le",
      speech_model: "universal-3-5-pro",
      format_turns: "true",
      keyterms_prompt: JSON.stringify(["Tesla", "TSLA", "Tech Giants"]),
    });
    expect(s.auth).toBe(KEY); // AssemblyAI's header: the key itself, no "Bearer"
    expect(s.url.toString()).not.toContain(KEY);
    live.abort();
  });

  it("holds audio until Begin, sends it in 50-1000ms frames, reports partials, and on release ForceEndpoints and takes the formatted final", async () => {
    const partials: string[] = [];
    const live = make().stream([], { onPartial: (t) => partials.push(t) });
    for (let i = 0; i < 12; i++) live.send(slice(i + 1)); // 480ms, some of it before Begin
    await until(() => (sessions[0]?.frames.length ?? 0) > 0);
    await until(() => partials.length > 0);
    const t = await live.finish();
    const s = sessions[0]!;
    expect(t).toMatchObject({ provider: "assemblyai", text: "Buy $10 of Palantir." });
    expect(t.timing?.releaseToFinalMs).toBeGreaterThanOrEqual(0);
    expect(partials[0]).toBe("buy ten");
    expect(partials.at(-1)).toBe("Buy $10 of Palantir.");
    for (const f of s.frames) {
      expect(f.byteLength).toBeGreaterThanOrEqual(MIN_FRAME_BYTES);
      expect(f.byteLength).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    }
    // Every byte went out, in order (the last frame padded with silence to 50ms).
    const sent = new Uint8Array(s.frames.reduce((n, f) => n + f.byteLength, 0));
    s.frames.reduce((at, f) => (sent.set(f, at), at + f.byteLength), 0);
    expect([...sent.subarray(0, 12 * 1_280)]).toEqual([...Array.from({ length: 12 }, (_, i) => slice(i + 1)).flatMap((x) => [...x])]);
    expect(sent.byteLength - 12 * 1_280).toBeLessThan(MIN_FRAME_BYTES);
    await until(() => s.messages.some((m) => m.type === "Terminate"));
    expect(s.messages.map((m) => m.type)).toEqual(["ForceEndpoint", "Terminate"]);
  });

  it("a turn AssemblyAI ends by itself (end_of_turn, formatted) calls onEndOfTurn; an unformatted final doesn't", async () => {
    let ended = 0;
    const live = make().stream([], { onEndOfTurn: () => ended++ });
    live.send(new Uint8Array(3_200));
    await until(() => sessions[0]?.frames.length === 1);
    sessions[0]!.turn("what's tesla at", { end: true });
    await sleep(30);
    expect(ended).toBe(0);
    sessions[0]!.turn("What's Tesla at?", { end: true, formatted: true });
    await until(() => ended === 1);
    // The release after it: the finished turn is the transcript (no new turn came within the settle time).
    await expect(live.finish()).resolves.toMatchObject({ text: "What's Tesla at?" });
  });

  it("the Termination's billed seconds go to the daily meter", async () => {
    const meter = new DailyMeter(1_800);
    const live = make({ meter }).stream([]);
    live.send(new Uint8Array(3_200));
    await live.finish();
    await until(() => meter.usedToday > 0);
    expect(meter.usedToday).toBe(2.5);
  });

  it("a warm session is taken over by the next stream (one session), its keyterms brought up to date", async () => {
    const aai = make();
    aai.warm!(["Tesla"]);
    await until(() => sessions.length === 1);
    await sleep(50); // Begin arrives
    const live = aai.stream(["Tesla", "My Basket"]);
    live.send(new Uint8Array(3_200));
    const t = await live.finish();
    expect(sessions).toHaveLength(1);
    expect(t.timing).toMatchObject({ warm: true, connectMs: 0 });
    expect(sessions[0]!.messages[0]).toEqual({ type: "UpdateConfiguration", keyterms_prompt: ["Tesla", "My Basket"] });
  });

  it("uploads aren't streamed to AssemblyAI (they fall through to Deepgram)", async () => {
    await expect(make().transcribe(new Uint8Array(4), "audio/wav", [])).rejects.toMatchObject({ provider: "assemblyai", kind: "connection" });
  });

  it("close codes read as fall-through reasons: 1008 bad key -> 401, too many sessions -> 429, others -> connection", () => {
    expect(aaiError(1008, "Invalid API key")).toMatchObject({ status: 401 });
    expect(aaiError(1008, "Unauthorized connection: Too many concurrent sessions")).toMatchObject({ status: 429 });
    expect(aaiError(3009, "")).toMatchObject({ status: 429 });
    expect(aaiError(1011, "internal")).toMatchObject({ kind: "connection" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

/** A stand-in for Deepgram: records what it heard, answers with a fixed transcript. */
function fakeDeepgram(text = "buy ten dollars of Palantir"): Transcriber & { heard: number[]; streams: number } {
  const t = {
    name: "deepgram",
    model: "nova-3",
    heard: [] as number[],
    streams: 0,
    async transcribe() {
      return { text, confidence: 0.9, provider: "deepgram" };
    },
    stream(_k: readonly string[], hooks: StreamHooks = {}): LiveTranscription {
      t.streams++;
      let bytes = 0;
      return {
        turnDetection: false,
        send: (c) => {
          bytes += c.byteLength;
          hooks.onPartial?.(text);
        },
        finish: async () => (t.heard.push(bytes), { text, confidence: 0.9, provider: "deepgram" }),
        abort() {},
      };
    },
  };
  return t;
}

describe("fall-through to Deepgram", () => {
  const setup = (o: { beginTimeoutMs?: number; url?: string; meter?: DailyMeter } = {}) => {
    const logs: string[] = [];
    const dg = fakeDeepgram();
    const stt = withSttFallback(make(o), dg, { log: (l) => logs.push(l), primaryResting: () => Boolean(o.meter?.resting) });
    return { logs, dg, stt };
  };
  const speak = async (live: LiveTranscription, n = 10) => {
    for (let i = 0; i < n; i++) live.send(slice());
    await sleep(20);
  };

  it.each([
    ["a refused key (1008)", "refuse", /refused the session \(1008: Invalid API key\)/],
    ["too many sessions (1008)", "busy", /too many concurrent sessions/],
  ] as const)("%s: Deepgram hears all of the same audio, with one log line and no key", async (_what, open, reason) => {
    behaviour.open = open;
    const { logs, dg, stt } = setup();
    const live = stt.stream([]);
    await speak(live);
    await until(() => sessions.length === 1);
    await sleep(50);
    await speak(live, 5);
    const t = await live.finish();
    expect(t).toMatchObject({ provider: "deepgram", text: "buy ten dollars of Palantir" });
    expect(dg.heard).toEqual([15 * 1_280]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[voice\] transcription: assemblyai .*falling through to deepgram \(nova-3\) with \d\.\ds of audio$/);
    expect(logs[0]).toMatch(reason);
    expect(logs.join()).not.toContain(KEY);
  });

  it("an unreachable server: Deepgram", async () => {
    const { logs, stt } = setup({ url: "ws://127.0.0.1:9/v3/ws" });
    const live = stt.stream([]);
    await speak(live);
    await expect(live.finish()).resolves.toMatchObject({ provider: "deepgram" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/couldn't be reached|closed the session/);
  });

  it("no Begin in time (a timeout): Deepgram", async () => {
    behaviour.open = "silent";
    const { logs, dg, stt } = setup({ beginTimeoutMs: 150 });
    const live = stt.stream([]);
    await speak(live, 5);
    await sleep(200);
    await expect(live.finish()).resolves.toMatchObject({ provider: "deepgram" });
    expect(dg.heard).toEqual([5 * 1_280]);
    expect(logs[0]).toMatch(/timed out|didn't open a session within 150ms/);
  });

  it("AssemblyAI's daily seconds used up: Deepgram listens (no AssemblyAI session opened), with a log line", async () => {
    const meter = new DailyMeter(10);
    meter.add(10);
    const { logs, dg, stt } = setup({ meter });
    stt.warm!([]);
    const live = stt.stream([]);
    await speak(live, 3);
    await expect(live.finish()).resolves.toMatchObject({ provider: "deepgram" });
    expect(sessions).toHaveLength(0);
    expect(dg.streams).toBe(1);
    expect(logs).toEqual(["[voice] transcription: assemblyai's daily seconds are used up, deepgram (nova-3) listens today"]);
  });
});

describe("provider selection", () => {
  const base = { DEEPGRAM_MODEL: "nova-3", FISH_MODEL: "s2.1-pro", FISH_VOICE_ID: "x", FISH_LATENCY: "balanced" as const, INTENT_MODEL: "claude-haiku-4-5", DEEPGRAM_TTS_VOICE: "flux-sienna-en", VOICE_TTS: "deepgram" as const };
  const DG = "3f9a8c1b2d4e5f60718293a4b5c6d7e8f9a0b1c2";

  it("AssemblyAI by default when its key is set, Deepgram as the fallback; status names both, never a key", () => {
    const config = loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, ASSEMBLYAI_API_KEY: KEY, DEEPGRAM_API_KEY: DG });
    expect([config.STT_PROVIDER, config.ASSEMBLYAI_MODEL, config.ASSEMBLYAI_STT_SECONDS_PER_DAY]).toEqual(["assemblyai", "universal-3-5-pro", 1_800]);
    const v = selectVoiceProviders(config, { log: () => {} });
    expect(v.stt).toMatchObject({ name: "assemblyai", model: "universal-3-5-pro" });
    expect(v.status.stt).toEqual({ provider: "assemblyai", model: "universal-3-5-pro", fallback: "deepgram (nova-3)" });
    expect(JSON.stringify(v.status)).not.toContain(KEY);
  });

  it("STT_PROVIDER=deepgram, or no AssemblyAI key: Deepgram alone", () => {
    expect(selectVoiceProviders({ ...base, STT_PROVIDER: "deepgram", ASSEMBLYAI_API_KEY: KEY, DEEPGRAM_API_KEY: DG }, { log: () => {} }).stt?.name).toBe("deepgram");
    const v = selectVoiceProviders({ ...base, STT_PROVIDER: "assemblyai", DEEPGRAM_API_KEY: DG }, { log: () => {} });
    expect(v.stt?.name).toBe("deepgram");
    expect(v.status.warnings.join()).toMatch(/ASSEMBLYAI_API_KEY/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("/voice/stream with AssemblyAI", () => {
  let port = 0;
  let stop: () => void = () => {};
  const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "", VOICE_PROVIDERS: "fake" }), () => {});
  beforeAll(async () => {
    const { app, injectWebSocket } = createServerApp(ctx);
    const server = serve({ fetch: app.fetch, port: 0 });
    injectWebSocket(server);
    await new Promise<void>((r) => server.once("listening", () => r()));
    port = (server.address() as AddressInfo).port;
    stop = () => server.close();
  });
  afterAll(() => stop());

  type Msg = { type: string; text?: string; provider?: string; endOfTurn?: boolean; code?: string; message?: string };
  const connect = async (query = "") => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/stream${query}`);
    const got: Msg[] = [];
    ws.addEventListener("message", (m) => got.push(JSON.parse(String(m.data)) as Msg));
    await new Promise((r) => ws.addEventListener("open", r));
    return { ws, got, transcript: () => got.find((m) => m.type === "transcript") };
  };

  it("conversation mode: live partials, and AssemblyAI's end of turn sends the transcript without a release", async () => {
    ctx.voice.stt = make();
    const { ws, got, transcript } = await connect(`?mode=conversation&keyterms=${encodeURIComponent(JSON.stringify(["Tech Giants"]))}`);
    for (let i = 0; i < 5; i++) ws.send(slice());
    await until(() => got.some((m) => m.type === "partial"));
    expect(got.find((m) => m.type === "partial")?.text).toBe("buy ten");
    sessions[0]!.turn("Buy $10 of Palantir.", { end: true, formatted: true }); // the speaker stopped
    await until(() => Boolean(transcript()));
    expect(transcript()).toMatchObject({ text: "Buy $10 of Palantir.", provider: "assemblyai", endOfTurn: true });
    // The session's basket name went in with the catalog's keyterms.
    const sent = JSON.parse(sessions[0]!.url.searchParams.get("keyterms_prompt")!) as string[];
    expect(sent).toEqual(expect.arrayContaining(["Tech Giants", "Tesla", "TSLA", "Palantir", "PLTR", "Glance", "USDG", "buy"]));
    ws.close();
  });

  it("hold-to-talk is unchanged: a turn ending mid-hold sends nothing; the release does", async () => {
    ctx.voice.stt = make();
    const { ws, got, transcript } = await connect();
    for (let i = 0; i < 5; i++) ws.send(slice());
    await until(() => (sessions[0]?.frames.length ?? 0) > 0);
    sessions[0]!.turn("What's Tesla at?", { end: true, formatted: true });
    await sleep(150);
    expect(transcript()).toBeUndefined();
    ws.send(JSON.stringify({ type: "stop" }));
    await until(() => Boolean(transcript()));
    expect(transcript()).toMatchObject({ text: "What's Tesla at?", endOfTurn: false });
    expect(got.filter((m) => m.type === "transcript")).toHaveLength(1);
  });

  it("conversation mode on the Deepgram fallback (no turn detection): 1.2s of quiet ends the turn", async () => {
    ctx.voice.stt = fakeDeepgram("how am I doing");
    const { ws, transcript } = await connect("?mode=conversation");
    ws.send(slice());
    await sleep(600);
    expect(transcript()).toBeUndefined();
    await until(() => Boolean(transcript()), 2_000);
    expect(transcript()).toMatchObject({ text: "how am I doing", provider: "deepgram", endOfTurn: true });
  });

  it("cancel (the panel closes the socket, Escape): the session is terminated, no transcript", async () => {
    ctx.voice.stt = make();
    const { ws, transcript } = await connect("?mode=conversation");
    ws.send(slice());
    await until(() => sessions.length === 1);
    ws.close();
    await until(() => sessions[0]!.messages.some((m) => m.type === "Terminate"));
    expect(transcript()).toBeUndefined();
  });

  it("every provider's seconds used up: \"Voice is resting for today\" at open", async () => {
    ctx.voice.stt = make();
    ctx.voice.meters!.stt.add(1e6);
    const { got } = await connect("?mode=conversation");
    await until(() => got.length > 0);
    expect(got[0]).toEqual({ type: "error", code: "VOICE_RESTING", message: VOICE_RESTING });
    expect(sessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("keyterms", () => {
  const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {});

  it("every stock by ticker and name, Glance's words and the verbs, within AssemblyAI's limits", () => {
    const k = keyterms(ctx);
    expect(k).toEqual(
      expect.arrayContaining(["TSLA", "Tesla", "AMZN", "Amazon", "PLTR", "Palantir", "NFLX", "Netflix", "AMD", "SPY", "QQQ", "Glance", "basket", "portfolio", "vault", "USDG", "buy", "compare", "chart"]),
    );
    expect(k.some((t) => /S&P 500/.test(t))).toBe(true);
    expect(k.some((t) => /Nasdaq-100/.test(t))).toBe(true);
    expect(k.length).toBeLessThanOrEqual(KEYTERM_MAX);
    for (const t of k) expect(t.length).toBeLessThanOrEqual(KEYTERM_MAX_CHARS);
    expect(new Set(k.map((t) => t.toLowerCase())).size).toBe(k.length);
  });

  it("a long catalog is cut to 100, and the session's basket names still fit", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ symbol: `S${i}`, name: `Company ${i}`, aliases: [`Alias ${i}`] }));
    const k = buildKeyterms(many, ["Tech Giants", "ETFs"]);
    // The catalog stops at 90 (Glance's words and verbs first, then tickers and names): room for 10 basket names.
    expect(k).toHaveLength(KEYTERM_MAX - 10 + 2);
    expect(k).toContain("Company 40"); // 82 places after the 8 fixed words: companies 0 to 40
    expect(k).not.toContain("S41");
    expect(k).not.toContain("Alias 0");
    expect(k.slice(-2)).toEqual(["Tech Giants", "ETFs"]);
    expect(buildKeyterms([{ symbol: "X", name: "y".repeat(60) }])).not.toContain("y".repeat(60));
  });

  it("the extension's basket names: plain short strings only, 10 at most", () => {
    expect(sessionKeyterms(["Tech Giants", "  ETFs ", 3, "<script>", "x".repeat(41), ...Array.from({ length: 20 }, (_, i) => `B${i}`)])).toEqual([
      "Tech Giants",
      "ETFs",
      ...Array.from({ length: 8 }, (_, i) => `B${i}`),
    ]);
    expect(sessionKeyterms("nope")).toEqual([]);
  });
});
