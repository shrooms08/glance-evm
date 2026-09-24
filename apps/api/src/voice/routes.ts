/**
 * Voice endpoints. Audio comes in from the extension's own context (never a web page), text and audio go back.
 *
 *   GET  /voice/status       which providers are active (no keys, ever)
 *   WS   /voice/stream       audio chunks while Option+V is held; {"type":"stop"} on release -> {"type":"transcript"}
 *   POST /voice/transcribe   a whole recording (fallback when the stream can't open) -> { text, confidence }
 *   POST /voice/command      transcript + page context -> { intent, symbol, amount, reply }
 *   POST /voice/speak        text -> audio/mpeg (identical short phrases served from memory)
 *
 * A command never trades. "buy" only tells the extension which card to open; the trade still needs the on-chain
 * preflight, the confirm tap, and every vault guard, exactly like the typed path.
 */
import type { Context, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { isAddress } from "viem";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { LINES } from "@glance/core/persona";

import { ApiError, portfolioView, priceView, vaultView, whyView } from "../services.js";
import { spokenSummary } from "../why.js";
import { understand, type Intent, type VoiceContext } from "./intent.js";
import { warmAnthropic } from "../anthropicHttp.js";

const MAX_AUDIO_BYTES = 2_000_000; // ~60s of opus: far more than a command
const MAX_STREAM_MS = 60_000;
/**
 * Spoken facts may be this old. Quotes and trades always read fresh; this only lets a spoken price be ready the moment
 * the transcript is (the feeds move every few minutes at most: the keeper mirrors mainnet every 5).
 */
const SPOKEN_FACT_MAX_AGE_MS = 15_000;

/** Short-lived facts for spoken replies, prefetched while the user is still holding the key. */
const facts = new Map<string, { at: number; value: Promise<unknown> }>();
function cachedFact<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = facts.get(key);
  if (hit && Date.now() - hit.at < SPOKEN_FACT_MAX_AGE_MS) return hit.value as Promise<T>;
  const value = load();
  value.catch(() => facts.delete(key));
  facts.set(key, { at: Date.now(), value });
  return value;
}
const priceFact = (ctx: AppContext, symbol: string, vault?: string) =>
  cachedFact(`price:${symbol}:${vault ?? ""}`, () => priceView(ctx, symbol, vault));
const vaultFact = (ctx: AppContext, vault: string) => cachedFact(`vault:${vault.toLowerCase()}`, () => vaultView(ctx, vault));

/** While the key is held: warm every price (and the vault's spending, if we know the vault) for the reply. */
export function prefetchFacts(ctx: AppContext, vault?: string) {
  for (const c of ctx.catalog.entries) priceFact(ctx, c.symbol, vault).catch(() => {});
  if (vault) vaultFact(ctx, vault).catch(() => {});
}

const contextSchema = z
  .object({
    host: z.string().max(200).optional(),
    companies: z.array(z.object({ symbol: z.string().max(8), mentions: z.number().int().min(0).max(10_000) })).max(20).optional(),
    lastGuard: z.object({ code: z.string().max(64), message: z.string().max(400) }).nullable().optional(),
    lastReply: z.string().max(400).nullable().optional(),
    openCard: z.string().max(8).nullable().optional(),
  })
  .strict();
const commandBody = z
  .object({
    transcript: z.string().trim().min(1).max(500),
    context: contextSchema.default({}),
    vault: z.string().refine((v) => isAddress(v, { strict: false }), "must be a 0x address").optional(),
  })
  .strict();
const speakBody = z.object({ text: z.string().trim().min(1).max(1_500) }).strict();

/** The words Deepgram should expect: our companies and tickers. */
export function keyterms(ctx: AppContext): string[] {
  const out = new Set<string>(["Glance"]);
  for (const c of ctx.catalog.entries) {
    out.add(c.name);
    out.add(c.symbol);
  }
  return [...out].slice(0, 40);
}

function unavailable(what: "transcription" | "speech"): never {
  throw new ApiError(503, "VOICE_UNAVAILABLE", `No ${what} provider is configured on the Glance API.`);
}

/** "$10", "$12.50", "$378.22": whole dollars without cents, so it sounds natural. */
const spoken = (usd: string) => {
  const n = Number(usd);
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
};

/**
 * The spoken reply. Facts (prices, spending) come from the chain through our own code, never from a model; Claude's
 * sentence is only used for explain and unknown, and only from the context facts it was given.
 */
export async function replyFor(ctx: AppContext, it: Intent, context: VoiceContext, vault?: string): Promise<{ reply: string; facts?: unknown }> {
  const name = it.symbol ? (ctx.catalog.bySymbol.get(it.symbol)?.name ?? it.symbol) : "";
  // A trade phrasing the validator refused: answer what was actually said, and never act on it.
  if (it.note?.includes("negation")) return { reply: LINES.wontTrade };
  const advice = it.note?.includes("advice") ? LINES.noAdvicePrefix : "";
  switch (it.intent) {
    case "buy":
      return {
        reply: it.amount ? LINES.buying(spoken(it.amount), name) : LINES.howMuch(name),
      };
    case "sell":
      return { reply: LINES.sellingElsewhere(name) };
    case "price": {
      const p = await priceFact(ctx, it.symbol!, vault);
      const market = p.marketState === "OPEN" ? "The market's open." : p.marketState === "CLOSED" ? "The market's closed." : "That price is too old to trade on.";
      return { reply: `${advice}${p.name} is at ${spoken(p.price.value)}. ${market}`, facts: { price: p.price.value, marketState: p.marketState } };
    }
    case "spend-so-far": {
      if (!vault) return { reply: LINES.noVaultSpent };
      const v = await vaultFact(ctx, vault);
      const w = v.buyWindow;
      return {
        reply: `You've spent ${w.used.formatted} of your ${w.limit.formatted} in the last 24 hours. ${w.remaining.formatted} left.`,
        facts: { used: w.used.formatted, limit: w.limit.formatted, remaining: w.remaining.formatted },
      };
    }
    case "portfolio": {
      if (!vault) return { reply: LINES.noVaultPortfolio };
      const p = await portfolioView(ctx, vault);
      return { reply: p.sentence, facts: { totals: p.totals } };
    }
    case "why": {
      const a = await whyView(ctx, it.symbol!);
      return { reply: spokenSummary(a, name), facts: { why: { summary: a.summary, sources: a.sources.length } } };
    }
    case "chart":
      // The extension opens the side panel on the chart; the chart itself is read from GET /chart there.
      return { reply: LINES.hereIsChart(name) };
    case "ask":
      // Answered by the page (POST /showme), which has the page text and draws while it talks: nothing to say here.
      return { reply: "" };
    case "explain":
      if (context.lastGuard) return { reply: context.lastGuard.message };
      return { reply: it.modelReply ?? LINES.nothingRefused };
    default:
      if (it.note?.includes("past") || it.note?.includes("hypothetical") || it.note?.includes("deferred")) {
        return { reply: LINES.onlyNow };
      }
      return { reply: it.modelReply ?? LINES.missingCompanyOrAmount };
  }
}

async function readAudio(c: Context): Promise<Uint8Array> {
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength === 0) throw new ApiError(400, "INVALID_INPUT", "No audio in the request body.");
  if (buf.byteLength > MAX_AUDIO_BYTES) throw new ApiError(400, "INVALID_INPUT", "That recording is too long for a command.");
  return buf;
}

/** Allowed WebSocket origins: our extension (any chrome-extension:// in development), and CORS_ORIGINS. */
function originAllowed(ctx: AppContext, origin: string | undefined): boolean {
  if (!origin) return ctx.config.NODE_ENV !== "production";
  if (ctx.config.corsOrigins.includes(origin)) return true;
  return ctx.config.NODE_ENV !== "production" && /^(chrome-extension:\/\/[a-p]{32}|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(origin);
}

export function registerVoice(
  app: Hono,
  ctx: AppContext,
  send: (c: Context, body: unknown, status?: 200 | 400 | 503) => Response,
  parse: <T extends z.ZodType>(schema: T, input: unknown) => z.infer<T>,
  jsonBody: (c: Context) => Promise<unknown>,
  upgradeWebSocket?: UpgradeWebSocket,
) {
  const v = ctx.voice;

  app.get("/voice/status", (c) =>
    send(c, {
      transcription: v.status.transcription,
      speech: v.status.speech,
      speechChain: v.speech.chain,
      speechFallbacks: v.status.speechFallbacks,
      intent: v.status.intent,
      available: { transcription: v.stt !== null, speech: v.tts !== null, stream: v.stt !== null && Boolean(upgradeWebSocket) },
      warnings: v.status.warnings,
    }),
  );

  /**
   * Warms both directions before they're needed: the Deepgram streaming connection (reused by the next command) and
   * the speech provider's HTTPS connection. The extension calls it when the panel opens and when Option+V goes down.
   */
  app.post("/voice/warm", (c) => {
    // Key down: the transcription stream, the speech provider's connection, and Claude's, all ready by the release.
    v.stt?.warm?.(keyterms(ctx));
    v.prewarmSpeech();
    if (ctx.showMe || ctx.intentModel) warmAnthropic();
    return send(c, { ok: true });
  });

  app.post("/voice/transcribe", async (c) => {
    if (!v.stt) unavailable("transcription");
    const started = performance.now();
    const audio = await readAudio(c);
    const t = await v.stt.transcribe(audio, c.req.header("content-type") ?? "application/octet-stream", keyterms(ctx));
    console.log(`[voice] transcription (upload): ${t.timing?.releaseToFinalMs ?? "?"}ms at the provider, ${Math.round(performance.now() - started)}ms here`);
    return send(c, { text: t.text, confidence: t.confidence, provider: v.stt.name, ms: Math.round(performance.now() - started) });
  });

  app.post("/voice/command", async (c) => {
    const started = performance.now();
    const body = parse(commandBody, await jsonBody(c));
    const it = await understand(body.transcript, body.context, ctx.catalog.entries, ctx.intentModel);
    const { reply, facts: replyFacts } = await replyFor(ctx, it, body.context, body.vault);
    return send(c, {
      intent: it.intent,
      symbol: it.symbol,
      amount: it.amount,
      reply,
      facts: replyFacts,
      source: it.source,
      note: it.note,
      ms: Math.round(performance.now() - started),
    });
  });

  /** A common line with no values in it: pre-recorded in the configured voice (generated once, then from .cache). */
  const prerecorded = async (text: string) => {
    const p = ctx.prerecorded;
    if (!p || !v.chain || !p.has(text)) return null;
    const out = await p.audio(text, v.chain);
    if (out.prerecorded) v.decisions.record({ at: new Date().toISOString(), voice: out.voice, provider: "deepgram", retry: false, fellThrough: [], firstByteMs: null, source: "prerecorded" });
    return out;
  };

  app.post("/voice/speak", async (c) => {
    if (!v.tts) unavailable("speech");
    const started = performance.now();
    const { text } = parse(speakBody, await jsonBody(c));
    const pre = await prerecorded(text);
    if (pre) {
      return c.body(pre.audio as unknown as ArrayBuffer, 200, {
        "content-type": "audio/mpeg",
        "cache-control": "no-store",
        "x-voice-cache": pre.prerecorded ? "prerecorded" : "generated",
        "x-voice": pre.voice,
        "x-voice-ms": String(Math.round(performance.now() - started)),
      });
    }
    const hitsBefore = v.tts.hits;
    const out = await v.tts.speak(text);
    return c.body(out.audio as unknown as ArrayBuffer, 200, {
      "content-type": out.mime,
      "cache-control": "no-store",
      "x-voice-cache": v.tts.hits > hitsBefore ? "hit" : "miss",
      "x-voice": v.decisions.list().at(-1)?.voice ?? "",
      "x-voice-ms": String(Math.round(performance.now() - started)),
    });
  });

  /**
   * The same speech as POST /voice/speak, as a GET an <audio> element can play while it downloads: a new phrase is
   * piped through from Fish as its chunks arrive (and cached when complete), so playback starts on the first bytes.
   */
  app.get("/voice/speak", async (c) => {
    if (!v.tts) unavailable("speech");
    const { text } = parse(speakBody, { text: c.req.query("text") ?? "" });
    const headers = { "content-type": "audio/mpeg", "cache-control": "no-store" };
    // ?voice=: a later sentence of a reply, in the voice that spoke its first sentence, and no other. If that voice
    // can't answer (after its retry), 503: the page stops speaking there and shows the rest.
    const pin = c.req.query("voice");
    if (pin) {
      const pinned = v.pinned(pin);
      if (!pinned) unavailable("speech");
      const pre = pin === ctx.prerecorded?.voice ? await prerecorded(text) : null;
      if (pre) return c.body(pre.audio as unknown as ArrayBuffer, 200, { ...headers, "x-voice-cache": "prerecorded", "x-voice": pre.voice });
      try {
        const out = await pinned!.streamDetailed(text);
        return c.body(out.stream, 200, { ...headers, "x-voice-cache": "miss", "x-voice": out.voice });
      } catch {
        return c.json({ error: { code: "VOICE_UNAVAILABLE", message: "That voice isn't answering right now." } }, 503);
      }
    }
    const pre = await prerecorded(text);
    if (pre) return c.body(pre.audio as unknown as ArrayBuffer, 200, { ...headers, "x-voice-cache": pre.prerecorded ? "prerecorded" : "generated", "x-voice": pre.voice });
    const streamer = v.tts.stream;
    if (!streamer || v.tts.has(text)) {
      const out = await v.tts.speak(text);
      return c.body(out.audio as unknown as ArrayBuffer, 200, { ...headers, "x-voice-cache": "hit", "x-voice": v.tts.voice });
    }
    // Which voice answered: the rest of a reply is pinned to it, and the extension's debug log names it. Never the text.
    const out = v.tts.streamDetailed ? await v.tts.streamDetailed(text) : { stream: await streamer(text), voice: v.tts.voice };
    return c.body(out.stream, 200, { ...headers, "x-voice-cache": "miss", "x-voice": out.voice });
  });

  if (upgradeWebSocket) {
    app.get(
      "/voice/stream",
      upgradeWebSocket((c) => {
        const allowed = originAllowed(ctx, c.req.header("origin"));
        let live: ReturnType<NonNullable<typeof v.stt>["stream"]> | null = null;
        let bytes = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let rewarm: ReturnType<typeof setInterval> | undefined;
        return {
          onOpen(_e, ws) {
            if (!allowed) return ws.close(1008, "origin not allowed");
            const vault = c.req.query("vault");
            prefetchFacts(ctx, vault && isAddress(vault, { strict: false }) ? vault : undefined);
            if (!v.stt) {
              ws.send(JSON.stringify({ type: "error", code: "VOICE_UNAVAILABLE", message: "No transcription provider is configured." }));
              return ws.close(1000);
            }
            live = v.stt.stream(keyterms(ctx));
            // The reply will need the speech provider soon: open its connection while the user is still speaking, and
            // keep it open through a long hold (the provider's edge drops idle connections after about 5s).
            v.prewarmSpeech();
            rewarm = setInterval(() => v.prewarmSpeech(), 3_000);
            timer = setTimeout(() => ws.close(1000, "too long"), MAX_STREAM_MS);
          },
          async onMessage(e, ws) {
            if (!live) return;
            if (typeof e.data === "string") {
              let msg: { type?: string } = {};
              try {
                msg = JSON.parse(e.data) as { type?: string };
              } catch {
                return;
              }
              if (msg.type !== "stop") return;
              clearInterval(rewarm);
              const stoppedAt = performance.now();
              try {
                const t = await live.finish();
                const ms = Math.round(performance.now() - stoppedAt);
                const tm = t.timing;
                // Where the time went (timings only: the words stay out of the logs).
                console.log(
                  `[voice] transcription: connect ${tm?.warm ? "0ms (warm connection reused)" : `${tm?.connectMs ?? "?"}ms (new connection, during speech)`}, release to final ${tm?.releaseToFinalMs ?? ms}ms, ${t.text.length} chars`,
                );
                ws.send(JSON.stringify({ type: "transcript", text: t.text, confidence: t.confidence, ms, timing: tm }));
              } catch (err) {
                ws.send(JSON.stringify({ type: "error", code: "TRANSCRIPTION_FAILED", message: (err as Error).message }));
              }
              live = null;
              return ws.close(1000);
            }
            const chunk = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : new Uint8Array(e.data as unknown as ArrayBufferLike);
            bytes += chunk.byteLength;
            if (bytes > MAX_AUDIO_BYTES) return ws.close(1009, "too much audio");
            live.send(chunk);
          },
          onClose() {
            clearTimeout(timer);
            clearInterval(rewarm);
            live?.abort();
            live = null;
          },
        };
      }),
    );
  }
}
