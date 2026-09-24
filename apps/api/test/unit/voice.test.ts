import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { extractAmounts, wordsToNumber } from "../../src/voice/amounts.js";
import { blocksTrade, rulesIntent, understand, validateIntent, type Intent, type IntentModel } from "../../src/voice/intent.js";
import { voiceHealth } from "../../src/services.js";
import {
  deepgram,
  deepgramSpeaker,
  deepgramSpeakRoute,
  fish,
  looksLikePlaceholder,
  ProviderError,
  selectVoiceProviders,
  withFallThrough,
  withPhraseCache,
  type Speaker,
} from "../../src/voice/providers.js";

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
    ["show me Tesla's chart", "chart", "TSLA", null],
    ["chart AMD", "chart", "AMD", null],
    ["open the Palantir chart", "chart", "PLTR", null],
    ["Netflix price chart", "chart", "NFLX", null],
    ["how much have I spent today", "spend-so-far", null, null],
    ["how much can I still spend", "spend-so-far", null, null],
    ["why was that blocked", "explain", null, null],
    ["sell Netflix", "sell", "NFLX", null],
  ])("%s -> %s %s %s", (said, intent, symbol, amount) => {
    const got = intentOf(said);
    expect([got.intent, got.symbol, got.amount]).toEqual([intent, symbol, amount]);
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
    const got = intentOf(said);
    expect(got.intent).not.toBe("buy");
    expect(got.intent).not.toBe("sell");
    expect(got.amount).toBeNull();
    expect(blocksTrade(said)).toBe(why);
  });

  it.each(["buy me a coffee", "buy ten dollars", "buy Apple", "get me out of here", "hello", "twelve fifty"])(
    "no catalog company: never a trade: %s",
    (said) => {
      const got = intentOf(said);
      expect(["buy", "sell"]).not.toContain(got.intent);
    },
  );

  it("an ambiguous amount is not guessed: the card asks instead", () => {
    const got = intentOf("buy twelve fifty of AMD");
    expect([got.intent, got.symbol, got.amount]).toEqual(["buy", "AMD", null]);
  });
});

describe("intent validator (applied to Claude's answers too)", () => {
  const claudeSays = (raw: Partial<Intent>): Intent => ({ intent: "buy", symbol: "TSLA", amount: "10", source: "claude", ...raw });

  it("drops a symbol that isn't in our catalog", () => {
    const got = validateIntent(claudeSays({ symbol: "AAPL" }), "buy ten dollars of Apple", catalog);
    expect(got.intent).toBe("unknown");
    expect(got.symbol).toBeNull();
  });
  it("drops an amount the user did not say, however plausible", () => {
    const got = validateIntent(claudeSays({ amount: "100" }), "buy some Tesla", catalog);
    expect([got.intent, got.symbol, got.amount]).toEqual(["buy", "TSLA", null]);
    expect(got.note).toMatch(/amount 100 was not said/);
  });
  it("keeps an amount only when it matches what was said, in any form", () => {
    expect(validateIntent(claudeSays({ amount: "$25.00" }), "buy twenty five dollars of Tesla", catalog).amount).toBe("25");
  });
  it("refuses a buy on a negation even if the model says buy", () => {
    const got = validateIntent(claudeSays({}), "don't buy ten dollars of Tesla", catalog);
    expect(got.intent).toBe("unknown");
    expect(got.amount).toBeNull();
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
    DEEPGRAM_TTS_VOICE: "aura-2-athena-en",
    VOICE_TTS: "deepgram" as const,
  };
  it("recognises placeholder keys", () => {
    for (const k of [undefined, "", "PASTE_YOUR_KEY_HERE", "YOUR_API_KEY", "changeme", "xxxxxxxxxxxxxxxxxxxx", "short"]) expect(looksLikePlaceholder(k)).toBe(true);
    expect(looksLikePlaceholder(REAL_LOOKING)).toBe(false);
  });
  it("speaks with the configured Aura voice (no Aura fallback after itself), with Fish as the fall-through", () => {
    const v = selectVoiceProviders({ ...cfg, DEEPGRAM_API_KEY: REAL_LOOKING, FISH_API_KEY: REAL_LOOKING }, { log: () => {} });
    expect(v.stt?.name).toBe("deepgram");
    expect(v.tts?.name).toBe("deepgram");
    expect(v.tts?.voice).toBe("aura-2-athena-en");
    expect(v.status.speech).toBe("deepgram aura-2-athena-en (Aura-2) via POST https://api.deepgram.com/v1/speak, mp3 streamed");
    expect(v.status.speechFallbacks).toBe("deepgram aura-2-athena-en -> fish s2.1-pro, on 401/402/429, a timeout (4s to first byte) or a connection error");
    expect(v.status.warnings).toEqual([]);
  });
  it("defaults to Flux Sienna on /v2/speak, then Aura Athena on /v1/speak, then Fish", () => {
    const config = loadConfig({ ...baseEnv, DEEPGRAM_API_KEY: REAL_LOOKING, FISH_API_KEY: REAL_LOOKING });
    expect(config.DEEPGRAM_TTS_VOICE).toBe("flux-sienna-en");
    const v = selectVoiceProviders(config, { log: () => {} });
    expect(v.tts?.voice).toBe("flux-sienna-en");
    expect(v.speech.chain).toEqual([
      { provider: "deepgram", voice: "flux-sienna-en", model: "flux", endpoint: "POST https://api.deepgram.com/v2/speak" },
      { provider: "deepgram", voice: "aura-2-athena-en", model: "aura-2", endpoint: "POST https://api.deepgram.com/v1/speak" },
      { provider: "fish", voice: "790560d72d4d455ba0464995cd534f27", model: "s2.1-pro", endpoint: "POST https://api.fish.audio/v1/tts" },
    ]);
    expect(v.status.speech).toBe("deepgram flux-sienna-en (Flux TTS) via POST https://api.deepgram.com/v2/speak, mp3 streamed");
    expect(v.status.speechFallbacks).toBe(
      "deepgram flux-sienna-en -> deepgram aura-2-athena-en -> fish s2.1-pro, on 401/402/429, a timeout (4s to first byte) or a connection error",
    );
  });
  it("VOICE_TTS=fish puts Fish first, with Deepgram as the fall-through", () => {
    const v = selectVoiceProviders({ ...cfg, VOICE_TTS: "fish", DEEPGRAM_API_KEY: REAL_LOOKING, FISH_API_KEY: REAL_LOOKING, FISH_MODEL: "s1" }, { log: () => {} });
    expect(v.tts?.name).toBe("fish");
    expect(v.tts?.model).toBe("s1");
    expect(v.status.speech).toMatch(/^fish \(s1, /);
    expect(v.status.speechFallbacks).toMatch(/^fish s1 -> deepgram aura-2-athena-en,/);
  });
  it("warns about a voice that is neither flux- nor aura-", () => {
    const v = selectVoiceProviders({ ...cfg, DEEPGRAM_TTS_VOICE: "sienna", DEEPGRAM_API_KEY: REAL_LOOKING }, { log: () => {} });
    expect(v.status.warnings.join()).toMatch(/neither a flux- nor an aura- voice/);
  });
  it("VOICE_TTS=fish without a Fish key uses Deepgram, and says so", () => {
    const v = selectVoiceProviders({ ...cfg, VOICE_TTS: "fish", DEEPGRAM_API_KEY: REAL_LOOKING }, { log: () => {} });
    expect(v.tts?.name).toBe("deepgram");
    expect(v.status.warnings.join()).toMatch(/VOICE_TTS=fish but FISH_API_KEY is not set/);
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
    expect(await dg.transcribe(new Uint8Array([1, 2, 3]), "audio/webm", ["Tesla"])).toMatchObject({ text: "buy $10 of Tesla", confidence: 0.97 });
  });
  it("errors name the status, never the key", async () => {
    const dg = deepgram({ apiKey: REAL_LOOKING, model: "nova-3", fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch });
    const err = await dg.transcribe(new Uint8Array([1]), "audio/webm", []).catch((e: Error) => e);
    expect((err as Error).message).toBe("Deepgram answered 401");
    expect(String(err)).not.toContain(REAL_LOOKING);
  });

  describe("live, with Finalize and a warm connection", () => {
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      readyState = 0;
      binaryType = "";
      sent: unknown[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((m: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      /** What to answer when Finalize arrives: a from_finalize result (default), or nothing. */
      answer: string | null = "what's Tesla at";
      /** Or a custom handler (for timeline tests): called on each Finalize. */
      onFinalize: (() => void) | null = null;
      finalizes = 0;
      constructor(
        public url: string,
        public init: { headers: Record<string, string> },
      ) {
        sockets.push(this);
      }
      open() {
        this.readyState = 1;
        this.onopen?.();
      }
      result(text: string, fromFinalize = false, window?: { start: number; duration: number }, isFinal = true) {
        this.onmessage?.({
          data: JSON.stringify({ type: "Results", is_final: isFinal, from_finalize: fromFinalize, ...window, channel: { alternatives: [{ transcript: text, confidence: 0.9 }] } }),
        });
      }
      send(d: unknown) {
        this.sent.push(d);
        if (typeof d !== "string" || JSON.parse(d).type !== "Finalize") return;
        this.finalizes++;
        if (this.onFinalize) this.onFinalize();
        else if (this.answer !== null) this.result(this.answer, true);
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    const make = (o: object = {}) => deepgram({ apiKey: REAL_LOOKING, model: "nova-3", WebSocket: FakeSocket as never, finishTimeoutMs: 500, ...o });
    const audio = (n: number) => sockets[n]!.sent.filter((d) => d instanceof Uint8Array);
    const json = (n: number) => sockets[n]!.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d).type);

    beforeEach(() => {
      sockets.length = 0;
    });

    it("asks for raw 16kHz PCM with our keyterms, the key only in the Authorization header", () => {
      make().stream(["Tesla", "TSLA"]);
      const u = new URL(sockets[0]!.url);
      expect(u.origin + u.pathname).toBe("wss://api.deepgram.com/v1/listen");
      expect(Object.fromEntries([...u.searchParams].filter(([k]) => k !== "keyterm"))).toMatchObject({ model: "nova-3", encoding: "linear16", sample_rate: "16000", channels: "1", endpointing: "100", smart_format: "true" });
      expect(u.searchParams.getAll("keyterm")).toEqual(["Tesla", "TSLA"]);
      expect(sockets[0]!.init.headers.Authorization).toBe(`Token ${REAL_LOOKING}`);
      expect(sockets[0]!.url).not.toContain(REAL_LOOKING);
    });

    it("on release sends Finalize and answers with the first from_finalize result, without waiting for silence", async () => {
      const live = make().stream(["Tesla"]);
      live.send(new Uint8Array([1])); // before open: buffered
      sockets[0]!.open();
      live.send(new Uint8Array([2])); // just after open: must still go out after the buffered chunk
      await new Promise((r) => setTimeout(r, 0));
      expect(audio(0).map((c) => [...(c as Uint8Array)])).toEqual([[1], [2]]);
      const t = await live.finish();
      expect(json(0)).toEqual(["Finalize"]);
      expect(t).toMatchObject({ text: "what's Tesla at", timing: { warm: false } });
    });

    it("reuses the warm connection for the next command: no second handshake", async () => {
      const dg = make();
      const first = dg.stream(["Tesla"]);
      sockets[0]!.open();
      first.send(new Uint8Array([1]));
      await first.finish();
      const second = dg.stream(["Tesla"]);
      second.send(new Uint8Array([2]));
      const t = await second.finish();
      expect(sockets).toHaveLength(1);
      expect(t.timing).toMatchObject({ warm: true, connectMs: 0 });
    });

    it("warm() opens the connection ahead of the first command", async () => {
      const dg = make();
      dg.warm!(["Tesla"]);
      sockets[0]!.open();
      const live = dg.stream(["Tesla"]);
      live.send(new Uint8Array([1]));
      expect((await live.finish()).timing?.warm).toBe(true);
      expect(sockets).toHaveLength(1);
    });

    it("if Deepgram had already finalised everything, takes what it has after a short grace", async () => {
      const live = make().stream([]);
      sockets[0]!.open();
      sockets[0]!.answer = null; // no from_finalize will come
      sockets[0]!.result("buy ten dollars of Tesla"); // finalised by endpointing, before release
      await expect(live.finish()).resolves.toMatchObject({ text: "buy ten dollars of Tesla" });
    });

    it("a second command while the warm connection is busy gets its own connection, closed after", async () => {
      const dg = make();
      const a = dg.stream([]);
      sockets[0]!.open();
      const b = dg.stream([]);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      await b.finish();
      expect(sockets[1]!.readyState).toBe(3);
      await a.finish();
      expect(sockets[0]!.readyState).toBe(1); // the warm one stays
    });

    /** 1s of 16kHz 16-bit mono PCM. */
    const second = () => new Uint8Array(32_000);

    it("a Finalize answer that stops short of the audio is asked again, and the parts are joined", async () => {
      const live = make().stream([]);
      const s = sockets[0]!;
      s.open();
      live.send(second());
      live.send(second());
      let n = 0;
      s.onFinalize = () => {
        n++;
        if (n === 1) s.result("buy ten dollars of", true, { start: 0, duration: 1.2 }); // only what it had processed
        else s.result("Tesla", true, { start: 1.2, duration: 0.8 });
      };
      const t = await live.finish();
      expect(t.text).toBe("buy ten dollars of Tesla");
      expect(s.finalizes).toBe(2);
    });

    it("ignores a late result that belongs to the previous command on the reused connection", async () => {
      const dg = make();
      const first = dg.stream([]);
      const s = sockets[0]!;
      s.open();
      first.send(second());
      s.onFinalize = () => s.result("what's Tesla at", true, { start: 0, duration: 1 });
      await first.finish();
      const next = dg.stream([]);
      next.send(second());
      s.onFinalize = () => {
        s.result("stale", true, { start: 0, duration: 0.9 }); // ends before this command began
        s.result("buy Amazon", true, { start: 1, duration: 1 });
      };
      expect((await next.finish()).text).toBe("buy Amazon");
    });

    it("a connection that opened late (a burst of backlog) lets Deepgram catch up before finalising", async () => {
      vi.useFakeTimers();
      const live = make({ finishTimeoutMs: 5_000 }).stream([]);
      const s = sockets[0]!;
      s.answer = null; // this test plays Deepgram's answers itself
      live.send(second()); // buffered while connecting: arrives as a 1s burst
      s.open();
      await vi.advanceTimersByTimeAsync(0);
      const done = live.finish();
      expect(s.finalizes).toBe(0); // not yet: Deepgram is still processing the burst
      s.result("buy ten dollars", false, { start: 0, duration: 0.8 }, false); // interim: processed up to 0.8s
      expect(s.finalizes).toBe(1); // within 0.3s of the release: finalise now
      s.result("buy ten dollars of Tesla", true, { start: 0, duration: 1 });
      await expect(done).resolves.toMatchObject({ text: "buy ten dollars of Tesla" });
      vi.useRealTimers();
    });

    it("an abandoned command closes its connection, so the next starts clean", async () => {
      const dg = make();
      const a = dg.stream([]);
      sockets[0]!.open();
      a.send(new Uint8Array([1]));
      a.abort();
      expect(sockets[0]!.readyState).toBe(3);
      dg.stream([]);
      expect(sockets).toHaveLength(2);
    });
  });
});

describe("Deepgram speech: routing by voice prefix", () => {
  const mp3 = new Uint8Array([0xff, 0xf3, 0x44, 0xc4, 0x00, 0x01, 0x02]); // an MPEG audio frame header and some bytes

  it("posts an Aura voice to /v1/speak, mp3, the key only in the header", async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.deepgram.com/v1/speak?model=aura-2-athena-en&encoding=mp3");
      expect((init!.headers as Record<string, string>).Authorization).toBe(`Token ${REAL_LOOKING}`);
      expect(JSON.parse(String(init!.body))).toEqual({ text: "Tesla is at $380." });
      return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/mpeg" } });
    });
    const s = deepgramSpeaker({ apiKey: REAL_LOOKING, voice: "aura-2-athena-en", fetch: fetchFn as unknown as typeof fetch });
    expect(s.model).toBe("aura-2");
    expect([...(await s.speak("Tesla is at $380.")).audio]).toEqual([1, 2]);
  });

  it("posts a Flux voice to /v2/speak, mp3, the key only in the header", async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.deepgram.com/v2/speak?model=flux-sienna-en&encoding=mp3");
      expect(String(url)).not.toContain(REAL_LOOKING);
      expect((init!.headers as Record<string, string>).Authorization).toBe(`Token ${REAL_LOOKING}`);
      expect(JSON.parse(String(init!.body))).toEqual({ text: "Tesla is at $380." });
      return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
    });
    const s = deepgramSpeaker({ apiKey: REAL_LOOKING, voice: "flux-sienna-en", fetch: fetchFn as unknown as typeof fetch });
    expect(s).toMatchObject({ name: "deepgram", model: "flux", voice: "flux-sienna-en", endpoint: "POST https://api.deepgram.com/v2/speak" });
    expect(await s.speak("Tesla is at $380.")).toEqual({ audio: mp3, mime: "audio/mpeg" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("routes by prefix: flux- to /v2/speak, aura- to /v1/speak", () => {
    expect(deepgramSpeakRoute("flux-sienna-en")).toEqual({ family: "flux", url: "https://api.deepgram.com/v2/speak" });
    expect(deepgramSpeakRoute("flux-haley-en").url).toMatch(/\/v2\/speak$/);
    expect(deepgramSpeakRoute("aura-2-athena-en")).toEqual({ family: "aura", url: "https://api.deepgram.com/v1/speak" });
    expect(deepgramSpeakRoute("aura-asteria-en").url).toMatch(/\/v1\/speak$/);
  });

  it("passes the streamed MP3 through untouched: same bytes, same chunks, audio/mpeg", async () => {
    const chunks = [mp3.slice(0, 3), mp3.slice(3)];
    const fetchFn = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              for (const ch of chunks) c.enqueue(ch);
              c.close();
            },
          }),
          { headers: { "content-type": "audio/mpeg" } },
        ),
    );
    const v = selectVoiceProviders({ ...loadConfig({ ...baseEnv, DEEPGRAM_API_KEY: REAL_LOOKING }), DEEPGRAM_API_KEY: REAL_LOOKING }, { fetch: fetchFn as unknown as typeof fetch, log: () => {} });
    const got: Uint8Array[] = [];
    const reader = (await v.tts!.stream!("Tesla is at $380.")).getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) got.push(r.value);
    expect(got).toEqual(chunks);
    // The route answers with the extension's format: audio/mpeg.
    const c2 = createContext(loadConfig(baseEnv));
    c2.voice = v;
    const res = await createApp(c2).request("/voice/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Tesla is at $380." }) });
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(mp3);
  });
});

describe("speech chain: Flux, then Aura, then Fish", () => {
  const FISH_URL = "https://api.fish.audio/v1/tts";
  /** A fake Deepgram and Fish: each URL answers as told ("ok", a status, "timeout" or "down"). */
  function providers(answers: Record<"flux" | "aura" | "fish", "ok" | number | "timeout" | "down">) {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const which = u.startsWith(FISH_URL) ? "fish" : u.includes("/v2/speak") ? "flux" : "aura";
      calls.push(which);
      const a = answers[which];
      if (a === "down") throw new TypeError("fetch failed");
      if (a === "timeout")
        return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      if (a !== "ok") return new Response("no", { status: a });
      return new Response(new Uint8Array([which.length]), { headers: { "content-type": "audio/mpeg" } });
    });
    const lines: string[] = [];
    const v = selectVoiceProviders(
      { ...loadConfig({ ...baseEnv, DEEPGRAM_API_KEY: REAL_LOOKING, FISH_API_KEY: REAL_LOOKING }), DEEPGRAM_API_KEY: REAL_LOOKING, FISH_API_KEY: REAL_LOOKING },
      { fetch: fetchFn as unknown as typeof fetch, log: (l) => lines.push(l) },
    );
    return { v, calls, lines, fetchFn };
  }
  const falls = (lines: string[]) => lines.filter((l) => l.includes("falling through"));

  it("Flux answers: nothing else is asked", async () => {
    const { v, calls, lines } = providers({ flux: "ok", aura: "ok", fish: "ok" });
    expect([...(await v.tts!.speak("Tesla is at $380.")).audio]).toEqual([4]);
    expect(calls).toEqual(["flux"]);
    expect(falls(lines)).toEqual([]);
    expect(v.speech.lastServedBy()?.voice).toBe("flux-sienna-en");
  });

  it.each([401, 402, 429])("Flux answers %i: Aura Athena speaks, with one log line", async (status) => {
    const { v, calls, lines } = providers({ flux: status, aura: "ok", fish: "ok" });
    expect([...(await v.tts!.speak("Tesla is at $380.")).audio]).toEqual([4]);
    expect(calls).toEqual(["flux", "aura"]);
    expect(falls(lines)).toHaveLength(1);
    expect(falls(lines)[0]).toMatch(new RegExp(`^\\[voice\\] speech: deepgram flux-sienna-en answered ${status}.*; falling through to deepgram aura-2-athena-en$`));
    expect(v.speech.lastServedBy()?.voice).toBe("aura-2-athena-en");
  });

  it("Flux times out before its first byte: Aura speaks", async () => {
    vi.useFakeTimers();
    try {
      const { v, calls, lines } = providers({ flux: "timeout", aura: "ok", fish: "ok" });
      const said = v.tts!.speak("Tesla is at $380.");
      await vi.advanceTimersByTimeAsync(4_001);
      expect([...(await said).audio]).toEqual([4]);
      expect(calls).toEqual(["flux", "aura"]);
      expect(falls(lines)).toEqual(["[voice] speech: deepgram flux-sienna-en timed out before its first byte; falling through to deepgram aura-2-athena-en"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Deepgram can't be reached at all: Flux, then Aura, then Fish, one line per fall-through", async () => {
    const { v, calls, lines } = providers({ flux: "down", aura: "down", fish: "ok" });
    expect([...(await v.tts!.speak("Tesla is at $380.")).audio]).toEqual([4]);
    expect(calls).toEqual(["flux", "aura", "fish"]);
    expect(falls(lines)).toEqual([
      "[voice] speech: deepgram flux-sienna-en couldn't be reached; falling through to deepgram aura-2-athena-en",
      "[voice] speech: deepgram aura-2-athena-en couldn't be reached; falling through to fish s2.1-pro",
    ]);
    expect(v.speech.lastServedBy()?.provider).toBe("fish");
    // Every fall-through is logged, not only the first.
    await v.tts!.speak("And again, a different line.");
    expect(falls(lines)).toHaveLength(4);
  });

  it("streams fall through the same way (before the first byte)", async () => {
    const { v, calls } = providers({ flux: 402, aura: 429, fish: "ok" });
    const reader = (await v.tts!.stream!("Tesla is at $380.")).getReader();
    expect([...(await reader.read()).value!]).toEqual([4]);
    expect(calls).toEqual(["flux", "aura", "fish"]);
  });

  it("a server error is final, not a fall-through", async () => {
    const { v, calls } = providers({ flux: 500, aura: "ok", fish: "ok" });
    await expect(v.tts!.speak("Tesla is at $380.")).rejects.toThrow("Deepgram answered 500");
    expect(calls).toEqual(["flux"]);
  });

  it("logs never carry the key or the text, only its length", async () => {
    const { v, lines } = providers({ flux: 402, aura: "ok", fish: "ok" });
    await v.tts!.speak("A secret sentence about Tesla.");
    expect(lines.join("\n")).not.toContain(REAL_LOOKING);
    expect(lines.join("\n")).not.toContain("secret");
    expect(lines.some((l) => /speech deepgram aura-2-athena-en: first byte \d+ms, .* 30 chars$/.test(l))).toBe(true);
  });

  it("/health names the voice in use, its endpoint and the fallbacks", async () => {
    const { v } = providers({ flux: "ok", aura: "ok", fish: "ok" });
    expect(voiceHealth({ voice: v })).toEqual({
      speech: { provider: "deepgram", voice: "flux-sienna-en", endpoint: "POST https://api.deepgram.com/v2/speak" },
      fallbacks: [
        { provider: "deepgram", voice: "aura-2-athena-en", endpoint: "POST https://api.deepgram.com/v1/speak" },
        { provider: "fish", voice: "790560d72d4d455ba0464995cd534f27", endpoint: "POST https://api.fish.audio/v1/tts" },
      ],
      lastServedBy: null,
    });
    await v.tts!.speak("hi");
    expect(voiceHealth({ voice: v }).lastServedBy).toBe("flux-sienna-en");
    expect(JSON.stringify(voiceHealth({ voice: v }))).not.toContain(REAL_LOOKING);
  });
});

describe("speech fall-through", () => {
  const speaker = (name: string, fail?: number): Speaker & { calls: number } => {
    const s = {
      name,
      model: "m",
      voice: "v",
      calls: 0,
      speak: async () => {
        s.calls++;
        if (fail) throw new ProviderError(name, fail, `${name} answered ${fail}`);
        return { audio: new Uint8Array([name.length]), mime: "audio/mpeg" };
      },
    };
    return s;
  };

  it.each([401, 402, 429])("hands the request to the next provider on %i, with one log line per fall-through", async (status) => {
    const warn = vi.fn();
    const first = speaker("deepgram", status);
    const second = speaker("fish");
    const chain = withFallThrough([first, second], warn);
    expect([...(await chain.speak("hi")).audio]).toEqual([4]);
    await chain.speak("again");
    expect(second.calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toMatch(new RegExp(`deepgram v answered ${status}.*falling through to fish m`));
    expect(warn.mock.calls[0]![0]).not.toContain(REAL_LOOKING);
  });

  it("any other failure is final (a server error isn't a billing problem)", async () => {
    const chain = withFallThrough([speaker("deepgram", 500), speaker("fish")], () => {});
    await expect(chain.speak("hi")).rejects.toThrow("deepgram answered 500");
  });

  it("the last provider's refusal is reported", async () => {
    const chain = withFallThrough([speaker("fish", 402)], () => {});
    await expect(chain.speak("hi")).rejects.toThrow("fish answered 402");
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
    expect(body).toMatchObject({ intent: "buy", symbol: "TSLA", amount: "10", reply: "$10 of Tesla. Let me check your limits first.", source: "rules" });
    expect(trade).not.toHaveBeenCalled();
  });

  it("/voice/command answers refusals honestly", async () => {
    const neg = (await (await post("/voice/command", { transcript: "don't buy Tesla" })).json()) as { intent: string; reply: string };
    expect(neg).toMatchObject({ intent: "unknown", reply: "Got it. Nothing bought, nothing sold." });
    const why = (await (await post("/voice/command", { transcript: "why?", context: { lastGuard: { code: "PER_TRADE_CAP", message: "That's over your $100 per trade limit." } } })).json()) as { reply: string };
    expect(why.reply).toBe("That's over your $100 per trade limit.");
  });

  it("/voice/command: \"show me Tesla's chart\" names the chart to open", async () => {
    const res = await post("/voice/command", { transcript: "show me Tesla's chart" });
    expect(await res.json()).toMatchObject({ intent: "chart", symbol: "TSLA", reply: "Here's Tesla's chart.", source: "rules" });
    // No company: nothing to chart.
    expect(await (await post("/voice/command", { transcript: "show me a chart" })).json()).toMatchObject({ intent: "unknown" });
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
