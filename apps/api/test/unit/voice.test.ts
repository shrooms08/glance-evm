import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { extractAmounts, wordsToNumber } from "../../src/voice/amounts.js";
import { blocksTrade, rulesIntent, understand, validateIntent, type Intent, type IntentModel } from "../../src/voice/intent.js";
import { deepgram, fish, looksLikePlaceholder, selectVoiceProviders, withPhraseCache, type Speaker } from "../../src/voice/providers.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const baseEnv = { NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" };
const ctx = createContext(loadConfig(baseEnv));
const catalog = ctx.catalog.entries;
const REAL_LOOKING = "3f9a8c1b2d4e5f60718293a4b5c6d7e8f9a0b1c2";

const intentOf = (said: string) => validateIntent(rulesIntent(said, catalog), said, catalog);

describe("amounts", () => {
  it("finds every amount actually said", () => {
    expect(extractAmounts("buy ten dollars of Tesla")).toEqual(["10"]);
    expect(extractAmounts("buy $25 of TSLA")).toEqual(["25"]);
    expect(extractAmounts("buy 12.50 of AMD")).toEqual(["12.5"]);
    expect(extractAmounts("buy twenty five bucks of amazon")).toEqual(["25"]);
    expect(extractAmounts("a hundred and fifty dollars of Palantir")).toEqual(["150"]);
    expect(extractAmounts("buy 2,500 of netflix")).toEqual(["2500"]);
    expect(extractAmounts("buy Tesla")).toEqual([]);
    expect(extractAmounts("buy a Tesla")).toEqual([]); // "a" alone is not one dollar
  });
  it("refuses number words that don't make one clear number", () => {
    expect(wordsToNumber(["twelve", "fifty"])).toBeNull(); // $12.50? $1,250?
    expect(wordsToNumber(["five", "ten"])).toBeNull();
    expect(wordsToNumber(["twenty", "five"])).toBe(25);
    expect(wordsToNumber(["one", "hundred", "and", "five"])).toBe(105);
  });
});

describe("intent (rules, validated)", () => {
  it.each([
    ["buy ten dollars of Tesla", "buy", "TSLA", "10"],
    ["Buy $25 of TSLA.", "buy", "TSLA", "25"],
    ["please buy twenty five bucks worth of amazon", "buy", "AMZN", "25"],
    ["I'd like to buy a hundred dollars of Palantir", "buy", "PLTR", "100"],
    ["can you buy 10 dollars of AMD", "buy", "AMD", "10"],
    ["buy Tesla", "buy", "TSLA", null], // no amount said: the card opens and asks
    ["what's Tesla at", "price", "TSLA", null],
    ["how much is Netflix", "price", "NFLX", null],
    ["Palantir stock price", "price", "PLTR", null],
    ["how much have I spent today", "spend-so-far", null, null],
    ["how much can I still spend", "spend-so-far", null, null],
    ["why was that blocked", "explain", null, null],
    ["sell Netflix", "sell", "NFLX", null],
  ])("%s -> %s %s %s", (said, intent, symbol, amount) => {
    const it = intentOf(said);
    expect([it.intent, it.symbol, it.amount]).toEqual([intent, symbol, amount]);
  });

  it.each([
    ["don't buy Tesla", "negation"],
    ["do not sell Amazon", "negation"],
    ["never buy Netflix", "negation"],
    ["should I buy Tesla?", "advice"],
    ["do you think I should sell Palantir", "advice"],
    ["is now a good time to buy AMD", "advice"],
    ["I bought Tesla yesterday", "past"],
    ["Tesla bought Twitter", "past"],
    ["what if I sold Amazon", "hypothetical"],
    ["I'm thinking about buying Netflix", "hypothetical"],
    ["remind me to buy Tesla tomorrow", "deferred"],
  ])("never a trade: %s (%s)", (said, why) => {
    const it = intentOf(said);
    expect(it.intent).not.toBe("buy");
    expect(it.intent).not.toBe("sell");
    expect(it.amount).toBeNull();
    expect(blocksTrade(said)).toBe(why);
  });

  it.each(["buy me a coffee", "buy ten dollars", "buy Apple", "get me out of here", "hello", "twelve fifty"])(
    "no catalog company: never a trade: %s",
    (said) => {
      const it = intentOf(said);
      expect(["buy", "sell"]).not.toContain(it.intent);
    },
  );

  it("an ambiguous amount is not guessed: the card asks instead", () => {
    const it = intentOf("buy twelve fifty of AMD");
    expect([it.intent, it.symbol, it.amount]).toEqual(["buy", "AMD", null]);
  });
});

describe("intent validator (applied to Claude's answers too)", () => {
  const claudeSays = (raw: Partial<Intent>): Intent => ({ intent: "buy", symbol: "TSLA", amount: "10", source: "claude", ...raw });

  it("drops a symbol that isn't in our catalog", () => {
    const it = validateIntent(claudeSays({ symbol: "AAPL" }), "buy ten dollars of Apple", catalog);
    expect(it.intent).toBe("unknown");
    expect(it.symbol).toBeNull();
  });
  it("drops an amount the user did not say, however plausible", () => {
    const it = validateIntent(claudeSays({ amount: "100" }), "buy some Tesla", catalog);
    expect([it.intent, it.symbol, it.amount]).toEqual(["buy", "TSLA", null]);
    expect(it.note).toMatch(/amount 100 was not said/);
  });
  it("keeps an amount only when it matches what was said, in any form", () => {
    expect(validateIntent(claudeSays({ amount: "$25.00" }), "buy twenty five dollars of Tesla", catalog).amount).toBe("25");
  });
  it("refuses a buy on a negation even if the model says buy", () => {
    const it = validateIntent(claudeSays({}), "don't buy ten dollars of Tesla", catalog);
    expect(it.intent).toBe("unknown");
    expect(it.amount).toBeNull();
  });
  it("turns an advice question into a price, never a trade", () => {
    expect(validateIntent(claudeSays({ amount: null }), "should I buy Tesla", catalog).intent).toBe("price");
  });

  it("uses Claude when present, and the rules when Claude fails", async () => {
    const good: IntentModel = { model: "test", classify: async () => ({ intent: "price", symbol: "tsla", amount: null, source: "claude" }) };
    expect(await understand("how's the car company doing", {}, catalog, good)).toMatchObject({ intent: "price", symbol: "TSLA", source: "claude" });
    const broken: IntentModel = { model: "test", classify: async () => Promise.reject(new Error("timeout")) };
    expect(await understand("buy ten dollars of Tesla", {}, catalog, broken)).toMatchObject({ intent: "buy", symbol: "TSLA", amount: "10", source: "rules" });
    expect(await understand("buy ten dollars of Tesla", {}, catalog, null)).toMatchObject({ source: "rules" });
  });
});

describe("provider selection and fallback", () => {
  const cfg = {
    DEEPGRAM_MODEL: "nova-3",
    FISH_MODEL: "s2.1-pro",
    FISH_VOICE_ID: "790560d72d4d455ba0464995cd534f27",
    FISH_LATENCY: "balanced" as const,
    INTENT_MODEL: "claude-haiku-4-5",
  };
  it("recognises placeholder keys", () => {
    for (const k of [undefined, "", "PASTE_YOUR_KEY_HERE", "YOUR_API_KEY", "changeme", "xxxxxxxxxxxxxxxxxxxx", "short"]) expect(looksLikePlaceholder(k)).toBe(true);
    expect(looksLikePlaceholder(REAL_LOOKING)).toBe(false);
  });
  it("uses Deepgram and Fish when both keys are real", () => {
    const v = selectVoiceProviders({ ...cfg, DEEPGRAM_API_KEY: REAL_LOOKING, FISH_API_KEY: REAL_LOOKING });
    expect(v.stt?.name).toBe("deepgram");
    expect(v.tts?.name).toBe("fish");
    expect(v.status.transcription).toBe("deepgram (nova-3)");
    expect(v.status.warnings).toEqual([]);
  });
  it("falls back to the browser (no server provider) without keys, and warns about placeholders", () => {
    const v = selectVoiceProviders({ ...cfg, DEEPGRAM_API_KEY: "PASTE_YOUR_KEY_HERE", FISH_API_KEY: undefined });
    expect(v.stt).toBeNull();
    expect(v.tts).toBeNull();
    expect(v.status.transcription).toMatch(/falls back to the browser/);
    expect(v.status.warnings.join()).toMatch(/DEEPGRAM_API_KEY looks like a placeholder/);
  });
  it("status never contains a key", () => {
    const v = selectVoiceProviders({ ...cfg, DEEPGRAM_API_KEY: REAL_LOOKING, FISH_API_KEY: REAL_LOOKING, ANTHROPIC_API_KEY: REAL_LOOKING });
    expect(JSON.stringify(v.status)).not.toContain(REAL_LOOKING);
  });
});

describe("Deepgram adapter", () => {
  it("pre-recorded: sends the audio with the key only in the Authorization header, and reads the transcript", async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toMatch(/^https:\/\/api\.deepgram\.com\/v1\/listen\?model=nova-3&/);
      expect(String(url)).toContain("keyterm=Tesla");
      expect(String(url)).not.toContain(REAL_LOOKING);
      expect((init!.headers as Record<string, string>).Authorization).toBe(`Token ${REAL_LOOKING}`);
      return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "buy $10 of Tesla", confidence: 0.97 }] }] } }));
    });
    const dg = deepgram({ apiKey: REAL_LOOKING, model: "nova-3", fetch: fetchFn as unknown as typeof fetch });
    expect(await dg.transcribe(new Uint8Array([1, 2, 3]), "audio/webm", ["Tesla"])).toEqual({ text: "buy $10 of Tesla", confidence: 0.97 });
  });
  it("errors name the status, never the key", async () => {
    const dg = deepgram({ apiKey: REAL_LOOKING, model: "nova-3", fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch });
    const err = await dg.transcribe(new Uint8Array([1]), "audio/webm", []).catch((e: Error) => e);
    expect((err as Error).message).toBe("Deepgram answered 401");
    expect(String(err)).not.toContain(REAL_LOOKING);
  });

  it("live: streams chunks as they come, buffers them until the socket opens, and CloseStream returns the transcript", async () => {
    const sent: unknown[] = [];
    let socket: FakeSocket;
    class FakeSocket {
      binaryType = "";
      onopen: (() => void) | null = null;
      onmessage: ((m: { data: string }) => void) | null = null;
      onclose: ((e: { code: number }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(
        public url: string,
        public init: { headers: Record<string, string> },
      ) {
        socket = this;
      }
      send(d: unknown) {
        sent.push(d);
        if (typeof d === "string" && JSON.parse(d).type === "CloseStream") {
          this.onmessage?.({ data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "what's Tesla at", confidence: 0.9 }] } }) });
          this.onclose?.({ code: 1000 });
        }
      }
      close() {}
    }
    const dg = deepgram({ apiKey: REAL_LOOKING, model: "nova-3", WebSocket: FakeSocket as never });
    const live = dg.stream(["Tesla"]);
    expect(socket!.init.headers.Authorization).toBe(`Token ${REAL_LOOKING}`);
    live.send(new Uint8Array([1])); // before open: buffered
    socket!.onopen!();
    live.send(new Uint8Array([2]));
    expect(sent).toHaveLength(2);
    expect(await live.finish()).toEqual({ text: "what's Tesla at", confidence: 0.9 });
    expect(sent.at(-1)).toBe(JSON.stringify({ type: "CloseStream" }));
  });
});

describe("Fish Audio adapter and phrase cache", () => {
  it("posts the text with the voice id and model header, bearer key only in the header", async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.fish.audio/v1/tts");
      const h = init!.headers as Record<string, string>;
      expect(h.Authorization).toBe(`Bearer ${REAL_LOOKING}`);
      expect(h.model).toBe("s2.1-pro");
      const body = JSON.parse(String(init!.body));
      expect(body).toMatchObject({ text: "Hello.", reference_id: "voice-1", format: "mp3" });
      expect(String(init!.body)).not.toContain(REAL_LOOKING);
      return new Response(new Uint8Array([9, 9, 9]));
    });
    const f = fish({ apiKey: REAL_LOOKING, model: "s2.1-pro", voice: "voice-1", latency: "balanced", fetch: fetchFn as unknown as typeof fetch });
    const out = await f.speak("Hello.");
    expect([...out.audio]).toEqual([9, 9, 9]);
    expect(out.mime).toBe("audio/mpeg");
  });

  it("serves identical short phrases from memory, shares in-flight calls, and never caches long text", async () => {
    let calls = 0;
    const inner: Speaker = { name: "fake", model: "m", voice: "v", speak: async (t) => (calls++, { audio: new TextEncoder().encode(t), mime: "audio/mpeg" }) };
    const s = withPhraseCache(inner, 2);
    await Promise.all([s.speak("I didn't catch that."), s.speak("I didn't catch that.")]);
    expect(calls).toBe(1);
    await s.speak("I didn't catch that.");
    expect(calls).toBe(1);
    expect(s.hits).toBe(1);
    await s.speak("two");
    await s.speak("three"); // evicts the least recently used
    await s.speak("I didn't catch that.");
    expect(calls).toBe(4);
    const long = "x".repeat(300);
    await s.speak(long);
    await s.speak(long);
    expect(calls).toBe(6);
  });
});

describe("voice endpoints", () => {
  const app = createApp(ctx);
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("/voice/status says which providers are active, with no keys", async () => {
    const body = (await (await app.request("/voice/status")).json()) as { available: Record<string, boolean> };
    expect(body.available).toMatchObject({ transcription: false, speech: false });
  });

  it("/voice/command: a spoken buy only names the card to open; nothing is traded", async () => {
    const trade = vi.spyOn(await import("../../src/services.js"), "tradeView");
    const res = await post("/voice/command", { transcript: "buy ten dollars of Tesla", context: { host: "cnbc.com" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ intent: "buy", symbol: "TSLA", amount: "10", reply: "$10 of Tesla. Checking your vault's limits.", source: "rules" });
    expect(trade).not.toHaveBeenCalled();
  });

  it("/voice/command answers refusals honestly", async () => {
    const neg = (await (await post("/voice/command", { transcript: "don't buy Tesla" })).json()) as { intent: string; reply: string };
    expect(neg).toMatchObject({ intent: "unknown", reply: "Okay. I won't buy or sell anything." });
    const why = (await (await post("/voice/command", { transcript: "why?", context: { lastGuard: { code: "PER_TRADE_CAP", message: "That's over your $100 per trade limit." } } })).json()) as { reply: string };
    expect(why.reply).toBe("That's over your $100 per trade limit.");
  });

  it("/voice/command validates its input", async () => {
    expect((await post("/voice/command", { transcript: "" })).status).toBe(400);
    expect((await post("/voice/command", { transcript: "hi", extra: 1 })).status).toBe(400);
  });

  it("/voice/transcribe and /voice/speak say plainly when no provider is configured", async () => {
    const t = await app.request("/voice/transcribe", { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array([1, 2]) });
    expect(t.status).toBe(503);
    expect(((await t.json()) as { error: { code: string } }).error.code).toBe("VOICE_UNAVAILABLE");
    expect((await post("/voice/speak", { text: "hi" })).status).toBe(503);
  });

  it("/voice/speak returns audio from the configured speaker, and marks cache hits", async () => {
    const c2 = createContext(loadConfig(baseEnv));
    let calls = 0;
    c2.voice.tts = withPhraseCache({ name: "fake", model: "m", voice: "v", speak: async () => (calls++, { audio: new Uint8Array([7, 7]), mime: "audio/mpeg" }) });
    const a2 = createApp(c2);
    const say = () => a2.request("/voice/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Tesla is at $380." }) });
    const first = await say();
    expect(first.headers.get("content-type")).toBe("audio/mpeg");
    expect(first.headers.get("x-voice-cache")).toBe("miss");
    expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([7, 7]);
    expect((await say()).headers.get("x-voice-cache")).toBe("hit");
    expect(calls).toBe(1);
  });
});
