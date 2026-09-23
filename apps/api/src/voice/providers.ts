/**
 * Voice providers behind one interface: Deepgram transcribes, Fish Audio speaks. The browser's own speech APIs are the
 * last resort and live in the extension (it falls back when this API is unreachable or has no provider).
 *
 * Keys stay here. They are sent only to the provider, in the Authorization header, and never logged, echoed or put in
 * an error message. A key that is obviously a placeholder ("PASTE_YOUR_KEY_HERE") counts as not configured.
 *
 * Deepgram (developers.deepgram.com), one key for both directions:
 *   listen   live wss://api.deepgram.com/v1/listen (and pre-recorded POST /v1/listen), `Authorization: Token <key>`,
 *            nova-3 with `keyterm` prompting for our companies and tickers, raw linear16 16kHz mono. On release we send
 *            {"type":"Finalize"} and take the result marked `from_finalize`: no waiting for end-of-speech detection.
 *            One connection is kept warm ({"type":"KeepAlive"} every 4s, closed after WARM_IDLE_MS unused) and reused
 *            command after command, so no command pays the 1-1.5s handshake to Deepgram.
 *   speak    POST https://api.deepgram.com/v1/speak?model=<Aura-2 voice>&encoding=mp3, JSON { text }; the audio
 *            streams back, so playback can start on the first bytes.
 * Fish Audio (docs.fish.audio): POST https://api.fish.audio/v1/tts, `Authorization: Bearer <key>`, a `model` header,
 *   JSON { text, reference_id, format, latency }; audio comes back as chunked bytes.
 * A speaker that answers 401, 402 or 429 hands the request to the next configured speaker, with one warning.
 */
import { Agent, fetch as undiciFetch } from "undici";

import { fakeSpeaker, fakeTranscriber } from "./fake.js";

/**
 * Provider requests keep their connections alive between requests: from far away (Lagos to Deepgram is ~300ms a round
 * trip) a new TLS connection costs about 0.8s before a request even starts. One undici version end to end: its own
 * fetch with its own Agent (mixing a package Agent into Node's built-in fetch mis-decodes compressed bodies).
 */
const keepAlive = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 16 });
export const providerFetch: typeof fetch = ((url: string | URL, init?: RequestInit) =>
  undiciFetch(url as never, { ...(init as object), dispatcher: keepAlive } as never)) as unknown as typeof fetch;

export interface Transcript {
  text: string;
  /** 0-1, from the provider. */
  confidence: number;
  /** Where the time went, for the per-request log. */
  timing?: TranscriptTiming;
}

export interface TranscriptTiming {
  /** Opening the connection to the provider; 0 when a warm connection was reused. */
  connectMs: number;
  warm: boolean;
  /** From the user letting go to the final transcript. */
  releaseToFinalMs: number;
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
  /** Live transcription of raw linear16 16kHz mono audio. */
  stream(keyterms: readonly string[]): LiveTranscription;
  /** Opens (or keeps open) a connection so the next command doesn't pay the handshake. */
  warm?(keyterms: readonly string[]): void;
}

export interface Speaker {
  readonly name: string;
  readonly model: string;
  readonly voice: string;
  speak(text: string): Promise<{ audio: Uint8Array; mime: string }>;
  /** The same audio as a byte stream, available as the provider sends it (for playback that starts early). */
  stream?(text: string): Promise<ReadableStream<Uint8Array>>;
}

/** Raw audio the extension streams: 16-bit little-endian PCM, 16kHz, mono. */
export const STREAM_SAMPLE_RATE = 16_000;
/** Deepgram reports segment windows to 0.01s; a result this close to the end of the audio covers it. */
const COVERAGE_SLACK_S = 0.1;
/** At release, audio Deepgram hasn't processed yet beyond this means a backlog: let it catch up before Finalize. */
const BACKLOG_SLACK_S = 0.3;
/** A late connection that received less than this in one burst is treated as keeping up. */
const BURST_S = 0.5;
/** The longest we wait for a backlog to be processed before finalising anyway. */
const BACKLOG_WAIT_MS = 1_500;
/** After a Finalize answer that stops short of the audio sent, when to ask again. */
const REFINALIZE_MS = 150;

/** Statuses that mean "this provider won't serve us right now": try the next one. */
export const FALL_THROUGH_STATUSES = new Set([401, 402, 429]);

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
// Deepgram: listen
// ---------------------------------------------------------------------------------------------------------------

type WebSocketCtor = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;

export interface DeepgramOptions {
  apiKey: string;
  model: string;
  /** Silence (ms) after which Deepgram finalises a segment on its own while the user is still speaking. */
  endpointingMs?: number;
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
  /** How long a warm connection may sit unused before it is closed. */
  warmIdleMs?: number;
  /** After Finalize, the longest wait for any transcript. */
  finishTimeoutMs?: number;
  now?: () => number;
}

function listenQuery(model: string, keyterms: readonly string[], extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ model, smart_format: "true", punctuate: "true", language: "en", ...extra });
  for (const k of keyterms) q.append("keyterm", k);
  return q.toString();
}

interface DgMessage {
  type?: string;
  is_final?: boolean;
  from_finalize?: boolean;
  /** Seconds into the connection's audio (it keeps counting across utterances on a reused connection). */
  start?: number;
  duration?: number;
  channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
}

/** One Deepgram live connection, reusable for utterance after utterance. */
class LiveConnection {
  readonly opened: Promise<boolean>;
  openMs = 0;
  busy = false;
  closed = false;
  lastUsed: number;
  /** Seconds of audio sent on this connection so far (Deepgram's timeline for `start` and `duration`). */
  audioSeconds = 0;
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private onMessage: ((m: DgMessage) => void) | null = null;
  private onDrop: (() => void) | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly now: () => number,
  ) {
    const started = now();
    this.lastUsed = started;
    ws.binaryType = "arraybuffer";
    this.opened = new Promise<boolean>((resolve) => {
      ws.onopen = () => {
        this.openMs = Math.round(now() - started);
        // Deepgram closes a connection after 10s without audio or a KeepAlive.
        this.keepAlive = setInterval(() => this.sendJson({ type: "KeepAlive" }), 4_000);
        resolve(true);
      };
      ws.onerror = () => resolve(false);
    });
    ws.onmessage = (m) => {
      try {
        this.onMessage?.(JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as ArrayBuffer)) as DgMessage);
      } catch {
        // not JSON: ignore
      }
    };
    ws.onclose = () => {
      this.closed = true;
      clearInterval(this.keepAlive);
      this.onDrop?.();
    };
  }

  get open() {
    return !this.closed && this.ws.readyState === 1;
  }

  sendJson(msg: object) {
    if (this.open) this.ws.send(JSON.stringify(msg));
  }

  sendAudio(chunk: Uint8Array) {
    if (!this.open) return;
    this.ws.send(chunk);
    this.audioSeconds += chunk.byteLength / (2 * STREAM_SAMPLE_RATE);
  }

  listen(onMessage: (m: DgMessage) => void, onDrop: () => void) {
    this.onMessage = onMessage;
    this.onDrop = onDrop;
  }

  release() {
    this.onMessage = null;
    this.onDrop = null;
    this.busy = false;
    this.lastUsed = this.now();
  }

  close() {
    clearInterval(this.keepAlive);
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

export function deepgram(opts: DeepgramOptions): Transcriber {
  const doFetch = opts.fetch ?? providerFetch;
  const WS = opts.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor);
  const now = opts.now ?? (() => performance.now());
  const auth = { Authorization: `Token ${opts.apiKey}` };
  const warmIdleMs = opts.warmIdleMs ?? 60_000;
  const timeoutMs = opts.finishTimeoutMs ?? 4_000;
  const liveParams = {
    // Interim results tell us how far Deepgram has processed; only final results carry the words we use.
    interim_results: "true",
    encoding: "linear16",
    sample_rate: String(STREAM_SAMPLE_RATE),
    channels: "1",
    endpointing: String(opts.endpointingMs ?? 100),
  };

  let warmConn: LiveConnection | null = null;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const openConnection = (keyterms: readonly string[]) =>
    new LiveConnection(new WS(`wss://api.deepgram.com/v1/listen?${listenQuery(opts.model, keyterms, liveParams)}`, { headers: auth }), now);
  const watchIdle = () => {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (warmConn && !warmConn.busy && now() - warmConn.lastUsed > warmIdleMs) {
        warmConn.close();
        warmConn = null;
      }
      if (!warmConn) {
        clearInterval(idleTimer);
        idleTimer = undefined;
      }
    }, 5_000);
  };
  /** The warm connection if it is free; otherwise a new one (which becomes the warm one if there is none). */
  const take = (keyterms: readonly string[]): { conn: LiveConnection; reused: boolean } => {
    if (warmConn && (warmConn.closed || !warmConn)) warmConn = null;
    if (warmConn && !warmConn.busy) {
      warmConn.busy = true;
      return { conn: warmConn, reused: warmConn.open };
    }
    const conn = openConnection(keyterms);
    conn.busy = true;
    if (!warmConn) {
      warmConn = conn;
      watchIdle();
    }
    return { conn, reused: false };
  };

  return {
    name: "deepgram",
    model: opts.model,
    warm(keyterms) {
      if (warmConn && !warmConn.closed) {
        warmConn.lastUsed = now();
        return;
      }
      warmConn = openConnection(keyterms);
      watchIdle();
    },
    async transcribe(audio, mime, keyterms) {
      const started = now();
      const res = await doFetch(`https://api.deepgram.com/v1/listen?${listenQuery(opts.model, keyterms)}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": mime || "application/octet-stream" },
        body: audio,
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new ProviderError("deepgram", res.status, `Deepgram answered ${res.status}`);
      const body = (await res.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }> }> } };
      const alt = body.results?.channels?.[0]?.alternatives?.[0];
      return { text: (alt?.transcript ?? "").trim(), confidence: alt?.confidence ?? 0, timing: { connectMs: 0, warm: false, releaseToFinalMs: Math.round(now() - started) } };
    },
    stream(keyterms) {
      const { conn, reused } = take(keyterms);
      const startedAt = now();
      /** Where this utterance begins on the connection's timeline: earlier results belong to an earlier command. */
      const utteranceStart = conn.audioSeconds;
      /** How far into the timeline final results have covered. */
      let coveredTo = utteranceStart;
      /** How far Deepgram has processed (interim or final results). */
      let processedTo = utteranceStart;
      let finalizeSent = false;
      /** Seconds of audio that reached Deepgram in one burst when a late connection opened. */
      let burstS = 0;
      let catchUpTimer: ReturnType<typeof setTimeout> | undefined;
      /** Finalize now: everything Deepgram has processed becomes final, and we answer when it covers the release. */
      const finalizeNow = () => {
        if (finalizeSent || done) return;
        finalizeSent = true;
        clearTimeout(catchUpTimer);
        conn.sendJson({ type: "Finalize" });
      };
      const finals: Array<{ text: string; confidence: number }> = [];
      const pending: Uint8Array[] = [];
      let failed: Error | null = null;
      let finishing: { resolve(t: Transcript): void; reject(e: Error): void; releasedAt: number; audioEnd: number } | null = null;
      let tailTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let done = false;

      const result = (): Transcript => {
        const withText = finals.filter((f) => f.text);
        return {
          text: withText.map((f) => f.text).join(" ").trim(),
          confidence: withText.length ? withText.reduce((a, f) => a + f.confidence, 0) / withText.length : 0,
          timing: {
            connectMs: reused ? 0 : conn.openMs || Math.round(now() - startedAt),
            warm: reused,
            releaseToFinalMs: finishing ? Math.round(now() - finishing.releasedAt) : 0,
          },
        };
      };
      const settle = () => {
        if (done || !finishing) return;
        done = true;
        clearTimeout(tailTimer);
        clearTimeout(hardTimer);
        clearTimeout(catchUpTimer);
        const out = result();
        conn.release();
        if (conn !== warmConn) conn.close(); // an extra connection (the warm one was busy) isn't kept
        finishing.resolve(out);
      };

      conn.listen(
        (m) => {
          if (m.type !== "Results") return;
          const end = (m.start ?? 0) + (m.duration ?? 0);
          if (m.start !== undefined && end <= utteranceStart + 0.01) return; // a late result from the previous command
          if (m.start !== undefined) processedTo = Math.max(processedTo, end);
          // Waiting for a late connection's backlog to be processed before finalising (so no word is cut in two).
          if (finishing && !finalizeSent && processedTo >= finishing.audioEnd - BACKLOG_SLACK_S) finalizeNow();
          if (!m.is_final) return;
          const alt = m.channel?.alternatives?.[0];
          finals.push({ text: (alt?.transcript ?? "").trim(), confidence: alt?.confidence ?? 0 });
          if (m.start !== undefined) coveredTo = Math.max(coveredTo, end);
          if (!finishing) return;
          // Done as soon as final results cover all the audio sent up to the release: no waiting for silence or an
          // utterance end. A large backlog (a connection that opened late) can come back as several results.
          if (m.start === undefined || coveredTo >= finishing.audioEnd - COVERAGE_SLACK_S) return settle();
          // The answer to our Finalize, but short of the end: Deepgram flushed only what it had processed (a backlog
          // from a connection that opened late is still being worked through). Ask again until it covers everything.
          if (m.from_finalize) {
            clearTimeout(tailTimer);
            tailTimer = setTimeout(() => conn.sendJson({ type: "Finalize" }), REFINALIZE_MS);
          }
        },
        () => {
          if (finishing && !done) {
            if (finals.length) return settle();
            done = true;
            finishing.reject(new ProviderError("deepgram", 0, "Deepgram's live connection closed"));
          } else failed = new ProviderError("deepgram", 0, "Deepgram's live connection closed");
        },
      );
      let flushed = reused;
      void conn.opened.then((ok) => {
        flushed = true;
        if (!ok) {
          failed = new ProviderError("deepgram", 0, "Deepgram's live connection failed");
          if (finishing && !done) {
            done = true;
            finishing.reject(failed);
          }
          return;
        }
        burstS = pending.reduce((n, c) => n + c.byteLength, 0) / (2 * STREAM_SAMPLE_RATE);
        for (const c of pending.splice(0)) conn.sendAudio(c);
        if (finishing) waitForBacklogThenFinalize();
      });

      /**
       * On a warm connection audio arrives as it is spoken and Deepgram keeps up: finalise at once. A connection that
       * opened late received its backlog in a burst: finalising mid-backlog can cut a word in two, so wait (briefly)
       * until Deepgram has processed up to the release.
       */
      function waitForBacklogThenFinalize() {
        if (!finishing) return;
        // Audio went out as it was spoken (a warm connection, or one that opened early): Deepgram is keeping up.
        if (burstS < BURST_S || processedTo >= finishing.audioEnd - BACKLOG_SLACK_S) return finalizeNow();
        catchUpTimer = setTimeout(finalizeNow, BACKLOG_WAIT_MS);
      }

      return {
        send(chunk) {
          if (failed || done) return;
          // Keep order: while buffered audio is still waiting to go out, new audio waits behind it.
          if (conn.open && pending.length === 0 && flushed) conn.sendAudio(chunk);
          else pending.push(chunk);
        },
        finish() {
          return new Promise<Transcript>((resolve, reject) => {
            if (failed) return reject(failed);
            // Everything buffered is sent before Finalize, so the utterance ends where all its audio ends.
            const buffered = pending.reduce((n, c) => n + c.byteLength, 0) / (2 * STREAM_SAMPLE_RATE);
            finishing = { resolve, reject, releasedAt: now(), audioEnd: conn.audioSeconds + buffered };
            // Deepgram may already have finalised everything before the release (then no from_finalize comes).
            if (finals.length && coveredTo >= finishing.audioEnd - COVERAGE_SLACK_S) return settle();
            if (conn.open) waitForBacklogThenFinalize();
            hardTimer = setTimeout(settle, timeoutMs);
          });
        },
        abort() {
          if (done) return;
          done = true;
          clearTimeout(tailTimer);
          clearTimeout(hardTimer);
          conn.release();
          // Audio already sent belongs to an abandoned utterance: start the next one on a clean connection.
          conn.close();
          if (conn === warmConn) warmConn = null;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Deepgram: speak (Aura)
// ---------------------------------------------------------------------------------------------------------------

export interface DeepgramSpeakOptions {
  apiKey: string;
  /** An Aura-2 voice, e.g. aura-2-athena-en. */
  voice: string;
  fetch?: typeof fetch;
}

export function deepgramSpeaker(opts: DeepgramSpeakOptions): Speaker {
  const doFetch = opts.fetch ?? providerFetch;
  const request = async (text: string) => {
    const res = await doFetch(`https://api.deepgram.com/v1/speak?${new URLSearchParams({ model: opts.voice, encoding: "mp3" })}`, {
      method: "POST",
      headers: { Authorization: `Token ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new ProviderError("deepgram", res.status, `Deepgram answered ${res.status}`);
    return res;
  };
  return {
    name: "deepgram",
    model: "aura-2",
    voice: opts.voice,
    async speak(text) {
      return { audio: new Uint8Array(await (await request(text)).arrayBuffer()), mime: "audio/mpeg" };
    },
    async stream(text) {
      const res = await request(text);
      if (!res.body) throw new ProviderError("deepgram", res.status, "Deepgram sent no audio");
      return res.body;
    },
  };
}

/**
 * Tries each speaker in order. One that answers 401 (key), 402 (billing) or 429 (rate limit) hands the request to the
 * next, and a single warning is logged per provider and status (never the key). Any other failure is final.
 */
export function withFallThrough(speakers: Speaker[], warn: (line: string) => void = (l) => console.warn(l)): Speaker {
  const warned = new Set<string>();
  const attempt = async <T>(run: (s: Speaker) => Promise<T>): Promise<T> => {
    let last: unknown;
    for (const [i, s] of speakers.entries()) {
      try {
        return await run(s);
      } catch (err) {
        last = err;
        const status = err instanceof ProviderError ? err.status : 0;
        if (!FALL_THROUGH_STATUSES.has(status) || i === speakers.length - 1) throw err;
        const key = `${s.name}:${status}`;
        if (!warned.has(key)) {
          warned.add(key);
          const why = status === 402 ? "payment required (check its API credit)" : status === 401 ? "the key was refused" : "rate limited";
          warn(`[voice] speech: ${s.name} answered ${status}, ${why}; using ${speakers[i + 1]!.name} instead`);
        }
      }
    }
    throw last;
  };
  const first = speakers[0]!;
  return {
    name: first.name,
    model: first.model,
    voice: first.voice,
    speak: (text) => attempt((s) => s.speak(text)),
    stream: speakers.some((s) => s.stream)
      ? (text) => attempt((s) => (s.stream ? s.stream(text) : s.speak(text).then((o) => new Response(o.audio as unknown as ArrayBuffer).body!)))
      : undefined,
  };
}

/** Times a speaker's first audio byte for the per-request log. */
export function withSpeechTiming(speaker: Speaker, log: (line: string) => void = (l) => console.log(l)): Speaker {
  const stamp = (text: string, t0: number, first: number, bytes: number, via: string) =>
    log(`[voice] speech ${via}: first byte ${Math.round(first)}ms, complete ${Math.round(performance.now() - t0)}ms, ${bytes} bytes, ${text.length} chars`);
  return {
    ...speaker,
    async speak(text) {
      const t0 = performance.now();
      const out = await speaker.speak(text);
      stamp(text, t0, performance.now() - t0, out.audio.byteLength, speaker.name);
      return out;
    },
    stream: speaker.stream
      ? async (text) => {
          const t0 = performance.now();
          const source = await speaker.stream!(text);
          let first = 0;
          let bytes = 0;
          return source.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, ctrl) {
                if (!first) first = performance.now() - t0;
                bytes += chunk.byteLength;
                ctrl.enqueue(chunk);
              },
              flush() {
                stamp(text, t0, first, bytes, `${speaker.name} (streamed)`);
              },
            }),
          );
        }
      : undefined,
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
  const doFetch = opts.fetch ?? providerFetch;
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
  DEEPGRAM_ENDPOINTING_MS?: number;
  DEEPGRAM_TTS_VOICE: string;
  /** Which speaker is tried first. The other one (if configured) is the fall-through. */
  VOICE_TTS: "deepgram" | "fish";
  FISH_API_KEY?: string;
  FISH_MODEL: string;
  FISH_VOICE_ID: string;
  FISH_LATENCY: "low" | "normal" | "balanced";
  ANTHROPIC_API_KEY?: string;
  INTENT_MODEL: string;
  /** How long an unused warm Deepgram connection stays open. 0 disables warming. */
  VOICE_WARM_IDLE_MS?: number;
}

export interface VoiceProviders {
  stt: Transcriber | null;
  tts: CachedSpeaker | null;
  /** Opens the speech provider's HTTPS connection ahead of time (kept alive), so the reply skips the TLS handshake. */
  prewarmSpeech(): void;
  /** Human-readable, key-free lines for the startup log and /health. */
  status: { transcription: string; speech: string; intent: string; warnings: string[] };
}

export function selectVoiceProviders(
  c: VoiceConfig,
  deps: { fetch?: typeof fetch; WebSocket?: WebSocketCtor; log?: (line: string) => void } = {},
): VoiceProviders {
  const warnings: string[] = [];
  const log = deps.log ?? ((l: string) => console.log(l));
  if (c.VOICE_PROVIDERS === "fake") {
    if (c.NODE_ENV === "production") throw new Error("VOICE_PROVIDERS=fake is for testing only and is refused in production");
    const delay = c.VOICE_FAKE_DELAY_MS ?? 0;
    const said = c.VOICE_FAKE_TRANSCRIPT ?? "what's Tesla at";
    return {
      stt: fakeTranscriber(said, delay),
      tts: withPhraseCache(fakeSpeaker(delay)),
      prewarmSpeech() {},
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
  const haveDeepgram = usable("DEEPGRAM_API_KEY", c.DEEPGRAM_API_KEY);
  const haveFish = usable("FISH_API_KEY", c.FISH_API_KEY);
  const stt = haveDeepgram
    ? deepgram({
        apiKey: c.DEEPGRAM_API_KEY!,
        model: c.DEEPGRAM_MODEL,
        endpointingMs: c.DEEPGRAM_ENDPOINTING_MS,
        warmIdleMs: c.VOICE_WARM_IDLE_MS,
        fetch: deps.fetch,
        WebSocket: deps.WebSocket,
      })
    : null;

  const aura = haveDeepgram ? deepgramSpeaker({ apiKey: c.DEEPGRAM_API_KEY!, voice: c.DEEPGRAM_TTS_VOICE, fetch: deps.fetch }) : null;
  const fishSpeaker = haveFish
    ? fish({ apiKey: c.FISH_API_KEY!, model: c.FISH_MODEL, voice: c.FISH_VOICE_ID, latency: c.FISH_LATENCY, fetch: deps.fetch })
    : null;
  const order = (c.VOICE_TTS === "fish" ? [fishSpeaker, aura] : [aura, fishSpeaker]).filter((s): s is Speaker => s !== null);
  if (c.VOICE_TTS === "fish" && !fishSpeaker) warnings.push("VOICE_TTS=fish but FISH_API_KEY is not set: using Deepgram");
  const describe = (s: Speaker) => (s.name === "deepgram" ? `deepgram aura (${s.voice})` : `fish (${s.model}, voice ${s.voice})`);
  const tts = order.length ? withPhraseCache(withSpeechTiming(withFallThrough(order), log)) : null;
  const claude = usable("ANTHROPIC_API_KEY", c.ANTHROPIC_API_KEY);
  const origin = order[0] ? (order[0].name === "deepgram" ? "https://api.deepgram.com/" : "https://api.fish.audio/") : null;
  const doFetch = deps.fetch ?? providerFetch;
  let lastWarm = 0;
  return {
    stt,
    tts,
    prewarmSpeech() {
      // A bare request to the origin leaves a kept-alive TLS connection in the pool for the real one (no key sent).
      // Deepgram's edge drops an idle connection after about 5s, so this runs on every key press (and during long
      // holds), not once in a while.
      if (!origin || Date.now() - lastWarm < 1_000) return;
      lastWarm = Date.now();
      void doFetch(origin, { method: "HEAD", signal: AbortSignal.timeout(5_000) }).then(
        (r) => r.body?.cancel(),
        () => {},
      );
    },
    status: {
      transcription: stt ? `deepgram (${stt.model}, live, warm connection reused)` : "none: the extension falls back to the browser's speech recognition",
      speech: order.length
        ? `${describe(order[0]!)}${order[1] ? `, falls through to ${describe(order[1])} on 401/402/429` : ""}`
        : "none: the extension falls back to the browser's speech synthesis",
      intent: claude ? `claude (${c.INTENT_MODEL}), validated` : "rules parser, validated (set ANTHROPIC_API_KEY for Claude)",
      warnings,
    },
  };
}
