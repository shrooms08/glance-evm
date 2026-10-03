/**
 * Paid endpoints protected: the daily speech-to-text seconds and speech characters caps (with the text-only fallback,
 * and pre-recorded lines not counting), the 30-second audio cap (upload and stream), the 64 KB body limit, per-session
 * rate limits, CORS allow and deny, and /health redacted in production. Fake voice providers; no network, no keys.
 */
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { SESSION_HEADERS, VOICE_RESTING } from "@glance/core/session";

import { createApp, createServerApp, isAdmin, MAX_JSON_BODY_BYTES, publicHealth } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { DailyMeter, voiceMeters } from "../../src/voice/dailyCaps.js";
import { MAX_AUDIO_SECONDS } from "../../src/voice/routes.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const env = { NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "", VOICE_PROVIDERS: "fake" };
const ctxWith = (extra: Record<string, string> = {}) => createContext(loadConfig({ ...env, ...extra }), () => {});

interface ErrorBody {
  error: { code: string; message: string };
}
const errorOf = async (r: Response) => ((await r.json()) as ErrorBody).error;

/** A WAV of `seconds` of silence at 16 kHz, 16-bit mono (header + samples). */
const wav = (seconds: number) => new Uint8Array(44 + Math.round(seconds * 32_000));

describe("daily voice caps", () => {
  it("a meter resets at midnight UTC and survives a restart (same day)", () => {
    let now = Date.parse("2026-09-24T23:59:00Z");
    const saved: number[] = [];
    const store = { load: () => saved.at(-1) ?? 0, save: (n: number) => void saved.push(n) };
    const m = new DailyMeter(100, store, () => now);
    m.add(60);
    expect(new DailyMeter(100, store, () => now).usedToday).toBe(60);
    m.add(50);
    expect(m.resting).toBe(true);
    now = Date.parse("2026-09-25T00:00:01Z");
    expect(m.resting).toBe(false);
    expect(m.usedToday).toBe(0);
  });

  it("speech characters: spoken until the cap, then 503 VOICE_RESTING, in text; pre-recorded lines never count", async () => {
    const ctx = ctxWith({ VOICE_TTS_CHARS_PER_DAY: "40" });
    const app = createApp(ctx);
    const say = (text: string) => app.request(`/voice/speak?text=${encodeURIComponent(text)}`);
    expect((await say("Tesla is at three eighty today.")).status).toBe(200); // 31 characters
    expect(ctx.voice.meters!.tts.usedToday).toBe(31);
    // The same phrase again comes from memory: not counted.
    expect((await say("Tesla is at three eighty today.")).status).toBe(200);
    expect(ctx.voice.meters!.tts.usedToday).toBe(31);
    expect((await say("Amazon is at two twenty.")).status).toBe(200); // 55 now: over
    const res = await say("Nvidia is at one ninety.");
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toEqual({ code: "VOICE_RESTING", message: VOICE_RESTING });
    expect(((await (await app.request("/voice/status")).json()) as { resting: { speech: boolean } }).resting.speech).toBe(true);
    const post = await app.request("/voice/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Something new to say." }) });
    expect(post.status).toBe(503);
  });

  it("speech-to-text seconds: uploads count; once used up, 503 VOICE_RESTING", async () => {
    const ctx = ctxWith({ VOICE_STT_SECONDS_PER_DAY: "10" });
    const app = createApp(ctx);
    const upload = (seconds: number) => app.request("/voice/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav(seconds) });
    expect((await upload(6)).status).toBe(200);
    expect(ctx.voice.meters!.stt.usedToday).toBeCloseTo(6, 3);
    expect((await upload(6)).status).toBe(200);
    const res = await upload(1);
    expect(res.status).toBe(503);
    expect((await errorOf(res)).message).toBe(VOICE_RESTING);
    expect(((await (await app.request("/voice/status")).json()) as { resting: { transcription: boolean } }).resting.transcription).toBe(true);
  });

  it("the meters share one file per day", () => {
    const m = voiceMeters({ sttSecondsPerDay: 1_800, ttsCharsPerDay: 60_000, file: null });
    expect([m.stt.limit, m.tts.limit]).toEqual([1_800, 60_000]);
    expect(loadConfig({}).VOICE_STT_SECONDS_PER_DAY).toBe(1_800);
    expect(loadConfig({}).VOICE_TTS_CHARS_PER_DAY).toBe(60_000);
  });
});

describe("audio length", () => {
  it("an upload longer than 30 seconds is refused with 413", async () => {
    const app = createApp(ctxWith());
    const res = await app.request("/voice/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav(MAX_AUDIO_SECONDS + 1) });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("AUDIO_TOO_LONG");
  });

  it("a stream takes 30 seconds of audio at most (the rest is dropped, and not counted); a resting day refuses at open", async () => {
    const ctx = ctxWith();
    const { app, injectWebSocket } = createServerApp(ctx);
    const server = serve({ fetch: app.fetch, port: 0 });
    injectWebSocket(server);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/stream`);
      const got = new Promise<{ type: string; text?: string; code?: string }>((r) => ws.addEventListener("message", (m) => r(JSON.parse(String(m.data)))));
      await new Promise((r) => ws.addEventListener("open", r));
      const second = new Uint8Array(32_000);
      for (let i = 0; i < 40; i++) ws.send(second); // 40 seconds of audio
      ws.send(JSON.stringify({ type: "stop" }));
      expect((await got).type).toBe("transcript");
      expect(ctx.voice.meters!.stt.usedToday).toBe(MAX_AUDIO_SECONDS);

      ctx.voice.meters!.stt.add(10_000);
      const rest = new WebSocket(`ws://127.0.0.1:${port}/voice/stream`);
      const refused = await new Promise<{ type: string; code?: string }>((r) => rest.addEventListener("message", (m) => r(JSON.parse(String(m.data)))));
      expect(refused).toMatchObject({ type: "error", code: "VOICE_RESTING" });
    } finally {
      server.close();
    }
  });
});

describe("request size", () => {
  it("a JSON body over 64 KB is refused with 413 (Show me's page context included)", async () => {
    const app = createApp(ctxWith());
    const body = JSON.stringify({ question: "what is this?", page: { title: "t", host: "h", text: "x".repeat(MAX_JSON_BODY_BYTES), companies: [] } });
    const res = await app.request("/showme", { method: "POST", headers: { "content-type": "application/json", "content-length": String(body.length) }, body });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("TOO_LARGE");
    const small = await app.request("/showme", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hi" }) });
    expect(small.status).toBe(200);
  });
});

describe("rate limits", () => {
  it("per browser session as well as per IP, when a session is named", async () => {
    const app = createApp(ctxWith({ SHOWME_RATE_LIMIT_PER_MINUTE: "2" }));
    const post = (session?: string) =>
      app.request("/showme", { method: "POST", headers: { "content-type": "application/json", ...(session ? { [SESSION_HEADERS.session]: session } : {}) }, body: JSON.stringify({ question: "hi" }) });
    const a = "0x1111111111111111111111111111111111111111";
    expect((await post(a)).status).toBe(200);
    expect((await post(a)).status).toBe(200);
    expect((await post(a)).status).toBe(429);
  });

  it("voice routes have their own per-IP limit", async () => {
    const app = createApp(ctxWith({ VOICE_RATE_LIMIT_PER_MINUTE: "1" }));
    expect((await app.request("/voice/status")).status).toBe(200);
    expect((await app.request("/voice/status")).status).toBe(429);
  });
});

describe("CORS", () => {
  const app = createApp(ctxWith({ CORS_ORIGINS: "chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl,https://console.glance.example" }));
  const preflight = (origin: string) =>
    app.request("/trade", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-glance-signature" } });

  it("allows the extension and the console, with the signed-request headers", async () => {
    for (const origin of ["chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl", "https://console.glance.example"]) {
      const res = await preflight(origin);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-glance-signature");
    }
  });

  it("denies any other origin (a random site, another extension, localhost when not listed)", async () => {
    for (const origin of ["https://evil.example", "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "http://localhost:5173"]) {
      expect((await preflight(origin)).headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("an empty CORS_ORIGINS (a copied .env.example) means the default, not none", () => {
    expect(loadConfig({ CORS_ORIGINS: "" }).corsOrigins).toEqual(["chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl", "http://localhost:3000"]);
  });

  it("production: the default is the extension and the hosted console, and localhost is never allowed, even listed", () => {
    expect(loadConfig({ NODE_ENV: "production", CORS_ORIGINS: "" }).corsOrigins).toEqual(["chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl", "https://glance-evm-console.vercel.app"]);
    expect(loadConfig({ NODE_ENV: "production" }).corsOrigins).toEqual(["chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl", "https://glance-evm-console.vercel.app"]);
    expect(
      loadConfig({ NODE_ENV: "production", CORS_ORIGINS: "chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl,https://glance-evm-console.vercel.app,http://localhost:3000,http://127.0.0.1:5173" }).corsOrigins,
    ).toEqual(["chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl", "https://glance-evm-console.vercel.app"]);
    // Outside production, a listed localhost stays (local development).
    expect(loadConfig({ NODE_ENV: "development", CORS_ORIGINS: "http://localhost:3000" }).corsOrigins).toEqual(["http://localhost:3000"]);
  });
});

describe("/health in production", () => {
  const full = {
    ok: true,
    chainId: 46_630,
    expectedChainId: 46_630,
    blockNumber: "123",
    agent: { address: "0xa7078432F7Aa4db99F88cB181049872d1ea697a9", keyLoaded: true, matchesDemoVault: true, ethBalance: "0.0019", ethBalanceWei: "1900000000000000" },
    llmFallback: true,
    llm: { usedToday: 12 },
    voice: { decisions: ["..."] },
    factories: [],
    keeper: { pausedLocally: false, lastWriteAt: 1_790_000_000 },
    feeds: [
      {
        symbol: "TSLA",
        price: { raw: "38000000000", decimals: 8, value: "380" },
        updatedAt: 1_790_000_000,
        ageSeconds: 60,
        age: "1m",
        marketState: "OPEN",
        source: "mainnet-mirror",
        sourceDetail: "x",
        mainnetFeed: "0x0",
        lastWrite: { at: 1_790_000_000, agoSeconds: 60, txHash: "0xabc" },
      },
    ],
    demoVaults: {},
  } as unknown as Parameters<typeof publicHealth>[0];

  it("shows only ok, chain, block, versions, the agent's address and the feeds' ages", () => {
    const h = publicHealth(full, "abc1234");
    expect(Object.keys(h).sort()).toEqual(["agent", "blockNumber", "chainId", "expectedChainId", "feeds", "keeper", "ok", "versions"]);
    expect(h.versions).toEqual({ api: "0.1.0", commit: "abc1234" });
    // The agent's address is public on chain; the console needs it to offer "Approve new Glance agent" after a rotation.
    expect(h.agent).toEqual({ address: "0xa7078432F7Aa4db99F88cB181049872d1ea697a9", keyLoaded: true });
    expect(publicHealth({ ...full, agent: { ...full.agent, keyLoaded: false } } as typeof full).agent).toEqual({ address: null, keyLoaded: false });
    const text = JSON.stringify(h);
    for (const secret of ["ethBalance", "matchesDemoVault", "llm", "decisions", "usedToday", "pausedLocally"]) expect(text).not.toContain(secret);
    expect(h.feeds[0]).toMatchObject({ symbol: "TSLA", ageSeconds: 60, marketState: "OPEN" });
  });

  it("the full view only with the admin token (compared in constant time)", () => {
    expect(isAdmin("a-long-admin-token-123", "a-long-admin-token-123")).toBe(true);
    expect(isAdmin("a-long-admin-token-123", "wrong")).toBe(false);
    expect(isAdmin(undefined, "anything")).toBe(false);
    expect(isAdmin("a-long-admin-token-123", undefined)).toBe(false);
  });
});
