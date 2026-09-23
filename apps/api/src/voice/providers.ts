/**
 * Voice providers behind one interface: Deepgram transcribes, Fish Audio speaks. The browser's own speech APIs are the
 * last resort and live in the extension (it falls back when this API is unreachable or has no provider).
 *
 * Keys stay here. They are sent only to the provider, in the Authorization header, and never logged, echoed or put in
 * an error message. A key that is obviously a placeholder ("PASTE_YOUR_KEY_HERE") counts as not configured.
 *
 * Deepgram (developers.deepgram.com): pre-recorded POST https://api.deepgram.com/v1/listen and live
 *   wss://api.deepgram.com/v1/listen, `Authorization: Token <key>`, model nova-3 with `keyterm` prompting for our
 *   company names and tickers. Live sessions end with {"type":"CloseStream"}, which flushes the final transcript.
 * Fish Audio (docs.fish.audio): POST https://api.fish.audio/v1/tts, `Authorization: Bearer <key>`, a `model` header,
 *   JSON { text, reference_id, format, latency }; audio comes back as chunked bytes.
 */
import { fakeSpeaker, fakeTranscriber } from "./fake.js";

export interface Transcript {
  text: string;
  /** 0-1, from the provider. */
  confidence: number;
}

export interface LiveTranscription {
  /** Audio as it is recorded (containerised webm/opus straight from MediaRecorder is fine). */
  send(chunk: Uint8Array): void;
  /** The user let go: flush and return the transcript. */
  finish(): Promise<Transcript>;
  abort(): void;
}

export interface Transcriber {
  readonly name: string;
  readonly model: string;
  transcribe(audio: Uint8Array, mime: string, keyterms: readonly string[]): Promise<Transcript>;
  stream(keyterms: readonly string[]): LiveTranscription;
}

export interface Speaker {
  readonly name: string;
  readonly model: string;
  readonly voice: string;
  speak(text: string): Promise<{ audio: Uint8Array; mime: string }>;
  /** The same audio as a byte stream, available as the provider sends it (for playback that starts early). */
  stream?(text: string): Promise<ReadableStream<Uint8Array>>;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** "PASTE_YOUR_KEY_HERE", "YOUR_KEY", "xxx", "changeme": not a real key. */
export function looksLikePlaceholder(key: string | undefined): boolean {
  if (!key) return true;
  const k = key.trim();
  if (k.length < 16) return true;
  if (/^[A-Z_]+$/.test(k)) return true;
  return /your|paste|replace|changeme|example|xxxx|placeholder|todo/i.test(k);
}

// ---------------------------------------------------------------------------------------------------------------
// Deepgram
// ---------------------------------------------------------------------------------------------------------------

type WebSocketCtor = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;

export interface DeepgramOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
  /** How long to wait for the final transcript after the user lets go. */
  finishTimeoutMs?: number;
}

function listenQuery(model: string, keyterms: readonly string[], extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ model, smart_format: "true", punctuate: "true", language: "en", ...extra });
  for (const k of keyterms) q.append("keyterm", k);
  return q.toString();
}

export function deepgram(opts: DeepgramOptions): Transcriber {
  const doFetch = opts.fetch ?? fetch;
  const WS = opts.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor);
  const auth = { Authorization: `Token ${opts.apiKey}` };
  return {
    name: "deepgram",
    model: opts.model,
    async transcribe(audio, mime, keyterms) {
      const res = await doFetch(`https://api.deepgram.com/v1/listen?${listenQuery(opts.model, keyterms)}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": mime || "application/octet-stream" },
        body: audio,
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new ProviderError("deepgram", res.status, `Deepgram answered ${res.status}`);
      const body = (await res.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }> }> } };
      const alt = body.results?.channels?.[0]?.alternatives?.[0];
      return { text: (alt?.transcript ?? "").trim(), confidence: alt?.confidence ?? 0 };
    },
    stream(keyterms) {
      const ws = new WS(`wss://api.deepgram.com/v1/listen?${listenQuery(opts.model, keyterms)}`, { headers: auth });
      ws.binaryType = "arraybuffer";
      const pending: Uint8Array[] = [];
      const finals: Array<{ text: string; confidence: number }> = [];
      let open = false;
      let failed: Error | null = null;
      let finishing: ((t: Transcript) => void) | null = null;
      let rejecting: ((e: Error) => void) | null = null;
      const result = (): Transcript => {
        const text = finals.map((f) => f.text).filter(Boolean).join(" ").trim();
        const withText = finals.filter((f) => f.text);
        const confidence = withText.length ? withText.reduce((a, f) => a + f.confidence, 0) / withText.length : 0;
        return { text, confidence };
      };
      ws.onopen = () => {
        open = true;
        for (const c of pending.splice(0)) ws.send(c);
        if (finishing) ws.send(JSON.stringify({ type: "CloseStream" }));
      };
      ws.onmessage = (m) => {
        try {
          const d = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as ArrayBuffer)) as {
            type?: string;
            is_final?: boolean;
            channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
          };
          if (d.type === "Results" && d.is_final) {
            const alt = d.channel?.alternatives?.[0];
            finals.push({ text: (alt?.transcript ?? "").trim(), confidence: alt?.confidence ?? 0 });
          }
        } catch {
          // not JSON: ignore
        }
      };
      ws.onerror = () => {
        failed = new ProviderError("deepgram", 0, "Deepgram's live connection failed");
        rejecting?.(failed);
      };
      ws.onclose = (e) => {
        if (finishing) return finishing(result());
        if (!failed) failed = new ProviderError("deepgram", e.code, `Deepgram closed the connection (${e.code})`);
      };
      return {
        send(chunk) {
          if (failed) return;
          if (open) ws.send(chunk);
          else pending.push(chunk);
        },
        finish() {
          return new Promise<Transcript>((resolve, reject) => {
            if (failed) return reject(failed);
            const timer = setTimeout(() => {
              try {
                ws.close();
              } catch {
                // already closed
              }
              resolve(result());
            }, opts.finishTimeoutMs ?? 4_000);
            finishing = (t) => {
              clearTimeout(timer);
              resolve(t);
            };
            rejecting = (e) => {
              clearTimeout(timer);
              reject(e);
            };
            if (open) ws.send(JSON.stringify({ type: "CloseStream" }));
          });
        },
        abort() {
          try {
            ws.close();
          } catch {
            // already closed
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Fish Audio
// ---------------------------------------------------------------------------------------------------------------

export interface FishOptions {
  apiKey: string;
  model: string;
  voice: string;
  latency: "low" | "normal" | "balanced";
  fetch?: typeof fetch;
}

export function fish(opts: FishOptions): Speaker {
  const doFetch = opts.fetch ?? fetch;
  const request = async (text: string) => {
    const res = await doFetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json", model: opts.model },
      body: JSON.stringify({ text, reference_id: opts.voice, format: "mp3", mp3_bitrate: 64, latency: opts.latency, normalize: true }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new ProviderError("fish", res.status, `Fish Audio answered ${res.status}`);
    return res;
  };
  return {
    name: "fish",
    model: opts.model,
    voice: opts.voice,
    async speak(text) {
      return { audio: new Uint8Array(await (await request(text)).arrayBuffer()), mime: "audio/mpeg" };
    },
    async stream(text) {
      const res = await request(text);
      if (!res.body) throw new ProviderError("fish", res.status, "Fish Audio sent no audio");
      return res.body;
    },
  };
}

/**
 * Identical short phrases come back from memory: a demo repeats the same lines ("I didn't catch that", review lines).
 * Least recently used entries go first once `max` is reached; long texts are never cached.
 */
export type CachedSpeaker = Speaker & { readonly cached: number; hits: number; has(text: string): boolean };

export function withPhraseCache(speaker: Speaker, max = 64, maxChars = 200): CachedSpeaker {
  const cache = new Map<string, { audio: Uint8Array; mime: string }>();
  const inflight = new Map<string, Promise<{ audio: Uint8Array; mime: string }>>();
  const self = {
    name: speaker.name,
    model: speaker.model,
    voice: speaker.voice,
    hits: 0,
    get cached() {
      return cache.size;
    },
    has(text: string) {
      return cache.has(text.trim());
    },
    /** Streams a new phrase through as it arrives, and caches it once complete. */
    stream: speaker.stream
      ? async (text: string) => {
          const key = text.trim();
          const source = await speaker.stream!(key);
          if (key.length > maxChars) return source;
          const parts: Uint8Array[] = [];
          return source.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, ctrl) {
                parts.push(chunk);
                ctrl.enqueue(chunk);
              },
              flush() {
                const audio = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
                let at = 0;
                for (const p of parts) {
                  audio.set(p, at);
                  at += p.byteLength;
                }
                cache.set(key, { audio, mime: "audio/mpeg" });
                while (cache.size > max) cache.delete(cache.keys().next().value!);
              },
            }),
          );
        }
      : undefined,
    async speak(text: string) {
      const key = text.trim();
      if (key.length > maxChars) return speaker.speak(key);
      const hit = cache.get(key);
      if (hit) {
        self.hits++;
        cache.delete(key);
        cache.set(key, hit); // most recently used
        return hit;
      }
      // Two requests for the same line at once share one provider call.
      const running = inflight.get(key);
      if (running) return running;
      const p = speaker.speak(key).then(
        (out) => {
          inflight.delete(key);
          cache.set(key, out);
          while (cache.size > max) cache.delete(cache.keys().next().value!);
          return out;
        },
        (err: unknown) => {
          inflight.delete(key);
          throw err;
        },
      );
      inflight.set(key, p);
      return p;
    },
  };
  return self;
}

// ---------------------------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------------------------

export interface VoiceConfig {
  NODE_ENV?: string;
  /** "fake" (not in production): exercise the whole path without provider keys. */
  VOICE_PROVIDERS?: "auto" | "fake";
  VOICE_FAKE_TRANSCRIPT?: string;
  VOICE_FAKE_DELAY_MS?: number;
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_MODEL: string;
  FISH_API_KEY?: string;
  FISH_MODEL: string;
  FISH_VOICE_ID: string;
  FISH_LATENCY: "low" | "normal" | "balanced";
  ANTHROPIC_API_KEY?: string;
  INTENT_MODEL: string;
}

export interface VoiceProviders {
  stt: Transcriber | null;
  tts: CachedSpeaker | null;
  /** Human-readable, key-free lines for the startup log and /health. */
  status: { transcription: string; speech: string; intent: string; warnings: string[] };
}

export function selectVoiceProviders(
  c: VoiceConfig,
  deps: { fetch?: typeof fetch; WebSocket?: WebSocketCtor } = {},
): VoiceProviders {
  const warnings: string[] = [];
  if (c.VOICE_PROVIDERS === "fake") {
    if (c.NODE_ENV === "production") throw new Error("VOICE_PROVIDERS=fake is for testing only and is refused in production");
    const delay = c.VOICE_FAKE_DELAY_MS ?? 0;
    const said = c.VOICE_FAKE_TRANSCRIPT ?? "what's Tesla at";
    return {
      stt: fakeTranscriber(said, delay),
      tts: withPhraseCache(fakeSpeaker(delay)),
      status: {
        transcription: `FAKE (testing only): always hears "${said}"`,
        speech: "FAKE (testing only): a pre-recorded clip",
        intent: c.ANTHROPIC_API_KEY && !looksLikePlaceholder(c.ANTHROPIC_API_KEY) ? `claude (${c.INTENT_MODEL}), validated` : "rules parser, validated",
        warnings: ["VOICE_PROVIDERS=fake: transcription and speech are simulated"],
      },
    };
  }
  const usable = (name: string, key: string | undefined) => {
    if (!key) return false;
    if (looksLikePlaceholder(key)) {
      warnings.push(`${name} looks like a placeholder, not a real key: ignored`);
      return false;
    }
    return true;
  };
  const stt = usable("DEEPGRAM_API_KEY", c.DEEPGRAM_API_KEY)
    ? deepgram({ apiKey: c.DEEPGRAM_API_KEY!, model: c.DEEPGRAM_MODEL, fetch: deps.fetch, WebSocket: deps.WebSocket })
    : null;
  const tts = usable("FISH_API_KEY", c.FISH_API_KEY)
    ? withPhraseCache(fish({ apiKey: c.FISH_API_KEY!, model: c.FISH_MODEL, voice: c.FISH_VOICE_ID, latency: c.FISH_LATENCY, fetch: deps.fetch }))
    : null;
  const claude = usable("ANTHROPIC_API_KEY", c.ANTHROPIC_API_KEY);
  return {
    stt,
    tts,
    status: {
      transcription: stt ? `deepgram (${stt.model})` : "none: the extension falls back to the browser's speech recognition",
      speech: tts ? `fish (${tts.model}, voice ${tts.voice})` : "none: the extension falls back to the browser's speech synthesis",
      intent: claude ? `claude (${c.INTENT_MODEL}), validated` : "rules parser, validated (set ANTHROPIC_API_KEY for Claude)",
      warnings,
    },
  };
}
