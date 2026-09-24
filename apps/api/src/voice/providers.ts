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
 *   speak    DEEPGRAM_TTS_VOICE picks the voice and the endpoint by its prefix:
 *              flux-*  Flux TTS, POST https://api.deepgram.com/v2/speak?model=<voice>&encoding=mp3, JSON { text }
 *                      (the batch REST transport: MP3, the format the extension already plays; its body streams, first
 *                      bytes in about 0.5s. The WebSocket transport is no faster warm, much slower cold, and only
 *                      sends raw PCM, which would need an MP3 encoder here.)
 *              aura-*  Aura-2, POST https://api.deepgram.com/v1/speak?model=<voice>&encoding=mp3, JSON { text }
 *            Either way the MP3 streams back and is passed through untouched, so playback starts on the first bytes.
 * Fish Audio (docs.fish.audio): POST https://api.fish.audio/v1/tts, `Authorization: Bearer <key>`, a `model` header,
 *   JSON { text, reference_id, format, latency }; audio comes back as chunked bytes.
 * The speech chain (default flux-sienna-en, then aura-2-athena-en, then Fish): a speaker that answers 401, 402 or 429,
 * times out before its first byte, or can't be reached hands the request to the next, with one log line each time.
 */
import { VoiceRestingError, type DailyMeter, type VoiceMeters } from "./dailyCaps.js";
import { Agent, fetch as undiciFetch } from "undici";

import { fakeSpeaker, fakeTranscriber } from "./fake.js";

/**
 * Provider requests keep their connections alive between requests: from far away (Lagos to Deepgram is ~300ms a round
 * trip) a new TLS connection costs about 0.8s before a request even starts. One undici version end to end: its own
 * fetch with its own Agent (mixing a package Agent into Node's built-in fetch mis-decodes compressed bodies).
 */
// Importing undici makes its Agent the process's global dispatcher (undici's own import side effect). Node's built-in
// fetch then can't decode gzip: the public testnet RPC's gzipped answers reach viem as garbage, and every chain read
// fails. So the whole process uses the same undici's fetch, which pairs with that dispatcher and decodes as it should.
globalThis.fetch = undiciFetch as unknown as typeof fetch;

const keepAlive = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 16 });
/** For a retry: its own pool whose connections don't outlive the request, so the retry never reuses a stuck one. */
const freshPool = new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 });
const freshFetch: typeof fetch = ((url: string | URL, init?: RequestInit) =>
  undiciFetch(url as never, { ...(init as object), dispatcher: freshPool } as never)) as unknown as typeof fetch;
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
  /** Where it speaks from, for the startup banner and /health ("POST https://api.deepgram.com/v2/speak"). */
  readonly endpoint?: string;
  /** The same voice tried once more, on a fresh connection. */
  readonly retry?: boolean;
  /** As speak(), with the voice that actually spoke (a chain may have fallen through). */
  speakDetailed?(text: string): Promise<{ audio: Uint8Array; mime: string; voice: string }>;
  /** As stream(), with the voice that actually speaks. */
  streamDetailed?(text: string): Promise<{ stream: ReadableStream<Uint8Array>; voice: string }>;
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
/** How long a speaker has to start answering before the next one is tried (the chain's retry and fallback). */
export const SPEECH_FIRST_BYTE_TIMEOUT_MS = 4_000;
/** The configured voice's first attempt gets longer: Flux answers in about 0.5s (1.6s cold), so 6s means it's stuck. */
export const PRIMARY_FIRST_BYTE_TIMEOUT_MS = 6_000;
/**
 * Once audio is flowing there is no total limit (Flux generates at about real time: a 290-character reply takes 11 to
 * 14 seconds to arrive). Only a stall ends it: no bytes for this long.
 */
export const SPEECH_STALL_MS = 8_000;

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    /** The HTTP status, or 0 when there was none (timeout, connection error). */
    readonly status: number,
    message: string,
    readonly kind: "status" | "timeout" | "connection" = "status",
  ) {
    super(message);
  }
}

/**
 * A provider request that gives up (ProviderError "timeout") if the answer hasn't started within `firstByteMs`, and
 * reports a network failure as ProviderError "connection". Neither message carries the URL's query or any header.
 */
async function speechRequest(doFetch: typeof fetch, provider: string, url: string, init: RequestInit, firstByteMs: number): Promise<Response> {
  const ctrl = new AbortController();
  let timedOut = false;
  const first = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, firstByteMs);
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: ctrl.signal });
  } catch {
    throw timedOut
      ? new ProviderError(provider, 0, `${provider} didn't answer within ${firstByteMs}ms`, "timeout")
      : new ProviderError(provider, 0, `${provider} couldn't be reached`, "connection");
  } finally {
    clearTimeout(first);
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    return res;
  }
  if (!res.body) return res;
  // No total cap on a clip that's flowing (a long reply used to be cut off at 20s, mid-sentence). Only a stall ends it:
  // a read that waits SPEECH_STALL_MS for bytes aborts the request.
  const reader = res.body.getReader();
  let stall: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      stall = setTimeout(() => {
        // Stalled: end this reply here, as an error (the page stops speaking; it never finishes in another voice).
        stalled = true;
        ctrl.abort();
        void reader.cancel().catch(() => {});
        c.error(new ProviderError(provider, 0, `${provider} stalled mid-reply`, "timeout"));
      }, SPEECH_STALL_MS);
      stall.unref?.();
      try {
        const { done, value } = await reader.read();
        clearTimeout(stall);
        if (stalled) return;
        if (done) c.close();
        else c.enqueue(value);
      } catch (err) {
        clearTimeout(stall);
        if (!stalled) c.error(err);
      }
    },
    cancel(reason) {
      clearTimeout(stall);
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, headers: res.headers });
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
// Deepgram: speak (Flux TTS and Aura-2)
// ---------------------------------------------------------------------------------------------------------------

export const DEFAULT_TTS_VOICE = "flux-sienna-en";
/**
 * The Aura-2 voice closest to Sienna ("clear, professional, calm, warm, caring"; American, female, young adult), from
 * Deepgram's Aura-2 catalog: Harmonia is "empathetic, clear, calm, confident", American, female. Athena ("calm, smooth,
 * professional") is tagged mature, an older voice; Hera ("smooth, warm, professional") matches two of Sienna's words.
 */
export const DEFAULT_TTS_FALLBACK_VOICE = "aura-2-harmonia-en";

/** Flux voices ("flux-sienna-en") are served on /v2/speak; Aura voices ("aura-2-athena-en") on /v1/speak. */
export function deepgramSpeakRoute(voice: string): { family: "flux" | "aura"; url: string } {
  const flux = voice.startsWith("flux-");
  const path = flux ? "/v2/speak" : "/v1/speak";
  return { family: flux ? "flux" : "aura", url: `https://api.deepgram.com${path}` };
}

export interface DeepgramSpeakOptions {
  apiKey: string;
  /** A Flux voice (flux-sienna-en) or an Aura-2 voice (aura-2-harmonia-en); the prefix picks the endpoint. */
  voice: string;
  fetch?: typeof fetch;
  firstByteMs?: number;
  /** This is the configured voice tried once more (on a fresh connection). */
  retry?: boolean;
}

export function deepgramSpeaker(opts: DeepgramSpeakOptions): Speaker {
  const doFetch = opts.fetch ?? providerFetch;
  const route = deepgramSpeakRoute(opts.voice);
  const request = async (text: string) => {
    // MP3 on both endpoints: exactly what the extension plays (audio/mpeg through MediaSource), passed through as is.
    const res = await speechRequest(
      doFetch,
      "deepgram",
      `${route.url}?${new URLSearchParams({ model: opts.voice, encoding: "mp3" })}`,
      {
        method: "POST",
        headers: { Authorization: `Token ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
      opts.firstByteMs ?? SPEECH_FIRST_BYTE_TIMEOUT_MS,
    );
    if (!res.ok) throw new ProviderError("deepgram", res.status, `Deepgram answered ${res.status}`);
    return res;
  };
  return {
    name: "deepgram",
    model: route.family === "flux" ? "flux" : "aura-2",
    voice: opts.voice,
    endpoint: `POST ${route.url}`,
    ...(opts.retry ? { retry: true } : {}),
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

/** "deepgram flux-sienna-en", "fish s2.1-pro": which speaker, for log lines. */
export const speakerLabel = (s: Pick<Speaker, "name" | "model" | "voice" | "retry">) =>
  `${s.name === "deepgram" ? `deepgram ${s.voice}` : `${s.name} ${s.model}`}${s.retry ? " (retry, fresh connection)" : ""}`;

/** Why a speaker was passed over: "429", "timeout after 6000ms", "connection error". */
const shortReason = (err: ProviderError) => (err.kind === "timeout" ? `timeout (${err.message.match(/\d+ms/)?.[0] ?? "first byte"})` : err.kind === "connection" ? "connection error" : String(err.status));

/** One reply's voice: who spoke it, who was passed over and why, and how long the first answer took. No text. */
export interface VoiceDecision {
  at: string;
  voice: string;
  provider: string;
  retry: boolean;
  fellThrough: Array<{ voice: string; reason: string }>;
  /** Time to the provider's answer (its first audio, for a stream). Null for a pre-recorded line. */
  firstByteMs: number | null;
  source: "live" | "prerecorded" | "memory";
}

/** The last `max` voice decisions, newest last. */
export class VoiceDecisions {
  private items: VoiceDecision[] = [];
  constructor(private readonly max = 20) {}
  record(d: VoiceDecision) {
    this.items.push(d);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }
  list(): VoiceDecision[] {
    return [...this.items];
  }
}

const fallReason = (err: ProviderError) =>
  err.kind === "timeout"
    ? "timed out before its first byte"
    : err.kind === "connection"
      ? "couldn't be reached"
      : `answered ${err.status}, ${err.status === 402 ? "payment required (check its API credit)" : err.status === 401 ? "the key was refused" : "rate limited"}`;

/** True for failures that hand the request to the next speaker: 401, 402, 429, a timeout or a connection error. */
export function fallsThrough(err: unknown): err is ProviderError {
  return err instanceof ProviderError && (FALL_THROUGH_STATUSES.has(err.status) || err.kind === "timeout" || err.kind === "connection");
}

/**
 * Tries each speaker in order. One that answers 401 (key), 402 (billing) or 429 (rate limit), times out before its first
 * byte, or can't be reached hands the request to the next, with one log line per fall-through (never the key or the
 * text). Any other failure is final. Each reply's decision (who spoke, who was passed over and why) goes to `decisions`.
 * Once audio has started, nothing falls through: a reply is never finished in another voice.
 */
export function withFallThrough(
  speakers: Speaker[],
  warn: (line: string) => void = (l) => console.warn(l),
  onServed?: (s: Speaker) => void,
  decisions?: VoiceDecisions,
): Speaker & Required<Pick<Speaker, "speakDetailed" | "streamDetailed">> {
  const attempt = async <T>(run: (s: Speaker) => Promise<T>): Promise<{ out: T; by: Speaker }> => {
    let last: unknown;
    const t0 = performance.now();
    const fellThrough: VoiceDecision["fellThrough"] = [];
    for (const [i, s] of speakers.entries()) {
      try {
        const out = await run(s);
        onServed?.(s);
        decisions?.record({
          at: new Date().toISOString(),
          voice: s.voice,
          provider: s.name,
          retry: Boolean(s.retry),
          fellThrough,
          firstByteMs: Math.round(performance.now() - t0),
          source: "live",
        });
        return { out, by: s };
      } catch (err) {
        last = err;
        if (!fallsThrough(err) || i === speakers.length - 1) throw err;
        fellThrough.push({ voice: s.voice, reason: shortReason(err) });
        warn(`[voice] speech: ${speakerLabel(s)} ${fallReason(err)}; falling through to ${speakerLabel(speakers[i + 1]!)}`);
      }
    }
    throw last;
  };
  const first = speakers[0]!;
  return {
    name: first.name,
    model: first.model,
    voice: first.voice,
    endpoint: first.endpoint,
    speak: async (text) => (await attempt((s) => s.speak(text))).out,
    async speakDetailed(text) {
      const { out, by } = await attempt((s) => s.speak(text));
      return { ...out, voice: by.voice };
    },
    stream: speakers.some((s) => s.stream) ? async (text) => (await attempt(streamOf(text))).out : undefined,
    async streamDetailed(text) {
      const { out, by } = await attempt(streamOf(text));
      return { stream: out, voice: by.voice };
    },
  };
}

const streamOf = (text: string) => (s: Speaker) => (s.stream ? s.stream(text) : s.speak(text).then((o) => new Response(o.audio as unknown as ArrayBuffer).body!));

/** Times a speaker's first audio byte for the per-request log (the text's length only, never the text). */
export function withSpeechTiming(speaker: Speaker, log: (line: string) => void = (l) => console.log(l), servedBy: () => string = () => speaker.name): Speaker {
  const stamp = (text: string, t0: number, first: number, bytes: number, via: string) =>
    log(`[voice] speech ${via}: first byte ${Math.round(first)}ms, complete ${Math.round(performance.now() - t0)}ms, ${bytes} bytes, ${text.length} chars`);
  const timed = (text: string, t0: number, source: ReadableStream<Uint8Array>) => {
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
          stamp(text, t0, first, bytes, `${servedBy()} (streamed)`);
        },
      }),
    );
  };
  return {
    ...speaker,
    async speak(text) {
      const t0 = performance.now();
      const out = await speaker.speak(text);
      stamp(text, t0, performance.now() - t0, out.audio.byteLength, servedBy());
      return out;
    },
    speakDetailed: speaker.speakDetailed
      ? async (text) => {
          const t0 = performance.now();
          const out = await speaker.speakDetailed!(text);
          stamp(text, t0, performance.now() - t0, out.audio.byteLength, servedBy());
          return out;
        }
      : undefined,
    stream: speaker.stream ? async (text) => timed(text, performance.now(), await speaker.stream!(text)) : undefined,
    streamDetailed: speaker.streamDetailed
      ? async (text) => {
          const t0 = performance.now();
          const out = await speaker.streamDetailed!(text);
          return { stream: timed(text, t0, out.stream), voice: out.voice };
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
  firstByteMs?: number;
}

export function fish(opts: FishOptions): Speaker {
  const doFetch = opts.fetch ?? providerFetch;
  const request = async (text: string) => {
    const res = await speechRequest(
      doFetch,
      "fish",
      "https://api.fish.audio/v1/tts",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json", model: opts.model },
        body: JSON.stringify({ text, reference_id: opts.voice, format: "mp3", mp3_bitrate: 64, latency: opts.latency, normalize: true }),
      },
      opts.firstByteMs ?? SPEECH_FIRST_BYTE_TIMEOUT_MS,
    );
    if (!res.ok) throw new ProviderError("fish", res.status, `Fish Audio answered ${res.status}`);
    return res;
  };
  return {
    name: "fish",
    model: opts.model,
    voice: opts.voice,
    endpoint: "POST https://api.fish.audio/v1/tts",
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


/**
 * Counts characters sent to a live speech provider against the daily cap, and refuses (VoiceRestingError) once it's
 * used up. Placed inside the phrase cache, so phrases served from memory never count (nor do pre-recorded lines, which
 * never reach this chain).
 */
export function withTtsCap<S extends Speaker>(speaker: S, meter: DailyMeter | null | undefined): S {
  if (!meter) return speaker;
  const charge = (text: string) => {
    if (meter.resting) throw new VoiceRestingError();
    meter.add(text.length);
  };
  const capped = Object.create(speaker) as S & Record<string, unknown>;
  Object.assign(capped, {
    speak: async (text: string) => (charge(text), speaker.speak(text)),
    ...(speaker.stream ? { stream: async (text: string) => (charge(text), speaker.stream!(text)) } : {}),
    ...(speaker.speakDetailed ? { speakDetailed: async (text: string) => (charge(text), speaker.speakDetailed!(text)) } : {}),
    ...(speaker.streamDetailed ? { streamDetailed: async (text: string) => (charge(text), speaker.streamDetailed!(text)) } : {}),
  });
  return capped;
}

export function withPhraseCache(speaker: Speaker, max = 64, maxChars = 200, configuredVoice: string = speaker.voice): CachedSpeaker {
  // Each entry remembers the voice that spoke it. Only the configured voice's audio is kept, and only it is served: a
  // phrase that once fell through to another voice is never replayed in that voice.
  const cache = new Map<string, { audio: Uint8Array; mime: string; voice: string }>();
  const inflight = new Map<string, Promise<{ audio: Uint8Array; mime: string; voice: string }>>();
  const keep = (key: string, entry: { audio: Uint8Array; mime: string; voice: string }) => {
    if (entry.voice !== configuredVoice) return;
    cache.set(key, entry);
    while (cache.size > max) cache.delete(cache.keys().next().value!);
  };
  const lookup = (key: string) => {
    const hit = cache.get(key);
    return hit && hit.voice === configuredVoice ? hit : undefined;
  };
  const detailed = (text: string) =>
    speaker.speakDetailed ? speaker.speakDetailed(text) : speaker.speak(text).then((o) => ({ ...o, voice: speaker.voice }));
  const detailedStream = (text: string) =>
    speaker.streamDetailed ? speaker.streamDetailed(text) : speaker.stream!(text).then((stream) => ({ stream, voice: speaker.voice }));
  const self = {
    name: speaker.name,
    model: speaker.model,
    voice: speaker.voice,
    endpoint: speaker.endpoint,
    hits: 0,
    get cached() {
      return cache.size;
    },
    has(text: string) {
      return lookup(text.trim()) !== undefined;
    },
    /** Streams a new phrase through as it arrives, and caches it once complete (if the configured voice spoke it). */
    stream: speaker.stream ? async (text: string) => (await self.streamDetailed!(text)).stream : undefined,
    /** As stream(), with the voice that speaks it (the rest of a reply is pinned to it). */
    streamDetailed: speaker.stream
      ? async (text: string) => {
          const key = text.trim();
          const { stream: source, voice } = await detailedStream(key);
          if (key.length > maxChars || voice !== configuredVoice) return { stream: source, voice };
          const parts: Uint8Array[] = [];
          const stream = source.pipeThrough(
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
                keep(key, { audio, mime: "audio/mpeg", voice });
              },
            }),
          );
          return { stream, voice };
        }
      : undefined,
    async speak(text: string) {
      const key = text.trim();
      if (key.length > maxChars) return speaker.speak(key);
      const hit = lookup(key);
      if (hit) {
        self.hits++;
        cache.delete(key);
        cache.set(key, hit); // most recently used
        return { audio: hit.audio, mime: hit.mime };
      }
      // Two requests for the same line at once share one provider call.
      const running = inflight.get(key);
      if (running) return running.then(({ audio, mime }) => ({ audio, mime }));
      const p = detailed(key).then(
        (out) => {
          inflight.delete(key);
          keep(key, out);
          return out;
        },
        (err: unknown) => {
          inflight.delete(key);
          throw err;
        },
      );
      inflight.set(key, p);
      return p.then(({ audio, mime }) => ({ audio, mime }));
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
  /** flux-* (Flux TTS, /v2/speak) or aura-* (Aura-2, /v1/speak). */
  DEEPGRAM_TTS_VOICE: string;
  /** The Aura voice tried after the configured voice fails twice ("" for none). */
  DEEPGRAM_TTS_FALLBACK_VOICE?: string;
  /** Which provider is tried first: Deepgram (its voice, a retry, then its fallback voice) or Fish (env only). */
  VOICE_TTS: "deepgram" | "fish";
  /** Fish after the Deepgram chain. Off by default: Fish's default voice is a different (male) voice. */
  VOICE_TTS_FISH_FALLBACK?: boolean;
  FISH_API_KEY?: string;
  FISH_MODEL: string;
  FISH_VOICE_ID: string;
  FISH_LATENCY: "low" | "normal" | "balanced";
  ANTHROPIC_API_KEY?: string;
  INTENT_MODEL: string;
  /** How long an unused warm Deepgram connection stays open. 0 disables warming. */
  VOICE_WARM_IDLE_MS?: number;
}

/** One link of the speech chain, as shown in the banner, /voice/status and /health. */
export interface SpeechLink {
  provider: string;
  voice: string;
  model: string;
  endpoint: string;
}

export interface VoiceProviders {
  stt: Transcriber | null;
  tts: CachedSpeaker | null;
  /** The chain itself, answering with the voice that spoke (for pre-recorded lines: only the configured voice is kept). */
  chain: (Speaker & { speakDetailed(text: string): Promise<{ audio: Uint8Array; mime: string; voice: string }> }) | null;
  /** The last 20 voice decisions, for /health. */
  decisions: VoiceDecisions;
  /**
   * The chain narrowed to one voice (its attempt and retry): the rest of a reply is spoken only in the voice that spoke
   * its first sentence, or not at all. Null when no speaker has that voice.
   */
  pinned(voice: string): (Speaker & Required<Pick<Speaker, "speakDetailed" | "streamDetailed">>) | null;
  /** The speech chain in order (first is the voice in use while it answers), and which one served the last reply. */
  speech: { chain: SpeechLink[]; lastServedBy(): SpeechLink | null };
  /** Opens the speech provider's HTTPS connection ahead of time (kept alive), so the reply skips the TLS handshake. */
  prewarmSpeech(): void;
  /** The daily caps (speech-to-text seconds, speech characters), when set. */
  meters: VoiceMeters | null;
  /** Human-readable, key-free lines for the startup log and /health. */
  status: { transcription: string; speech: string; speechFallbacks: string; intent: string; warnings: string[] };
}

export function selectVoiceProviders(
  c: VoiceConfig,
  deps: { fetch?: typeof fetch; WebSocket?: WebSocketCtor; log?: (line: string) => void; meters?: VoiceMeters } = {},
): VoiceProviders {
  const warnings: string[] = [];
  const log = deps.log ?? ((l: string) => console.log(l));
  if (c.VOICE_PROVIDERS === "fake") {
    if (c.NODE_ENV === "production") throw new Error("VOICE_PROVIDERS=fake is for testing only and is refused in production");
    const delay = c.VOICE_FAKE_DELAY_MS ?? 0;
    const said = c.VOICE_FAKE_TRANSCRIPT ?? "what's Tesla at";
    return {
      stt: fakeTranscriber(said, delay),
      tts: withPhraseCache(withTtsCap(fakeSpeaker(delay), deps.meters?.tts)),
      chain: null,
      decisions: new VoiceDecisions(),
      pinned: () => null,
      meters: deps.meters ?? null,
      speech: { chain: [], lastServedBy: () => null },
      prewarmSpeech() {},
      status: {
        transcription: `FAKE (testing only): always hears "${said}"`,
        speech: "FAKE (testing only): a pre-recorded clip",
        speechFallbacks: "none",
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

  const voice = c.DEEPGRAM_TTS_VOICE.trim() || DEFAULT_TTS_VOICE;
  if (!/^(flux|aura)-/.test(voice)) warnings.push(`DEEPGRAM_TTS_VOICE "${voice}" is neither a flux- nor an aura- voice: sent to /v1/speak`);
  const fallbackVoice = (c.DEEPGRAM_TTS_FALLBACK_VOICE ?? DEFAULT_TTS_FALLBACK_VOICE).trim();
  // The configured voice (6s to answer), the same voice once more on a fresh connection (4s), then the closest Aura
  // voice (4s). One person, always: Fish (a different voice) only when asked for by env.
  const deepgramChain = haveDeepgram
    ? [
        deepgramSpeaker({ apiKey: c.DEEPGRAM_API_KEY!, voice, fetch: deps.fetch, firstByteMs: PRIMARY_FIRST_BYTE_TIMEOUT_MS }),
        deepgramSpeaker({ apiKey: c.DEEPGRAM_API_KEY!, voice, fetch: deps.fetch ?? freshFetch, firstByteMs: SPEECH_FIRST_BYTE_TIMEOUT_MS, retry: true }),
        ...(fallbackVoice && fallbackVoice !== voice ? [deepgramSpeaker({ apiKey: c.DEEPGRAM_API_KEY!, voice: fallbackVoice, fetch: deps.fetch, firstByteMs: SPEECH_FIRST_BYTE_TIMEOUT_MS })] : []),
      ]
    : [];
  const fishSpeaker = haveFish
    ? fish({ apiKey: c.FISH_API_KEY!, model: c.FISH_MODEL, voice: c.FISH_VOICE_ID, latency: c.FISH_LATENCY, fetch: deps.fetch })
    : null;
  const order = (c.VOICE_TTS === "fish" ? [fishSpeaker, ...deepgramChain] : [...deepgramChain, c.VOICE_TTS_FISH_FALLBACK ? fishSpeaker : null]).filter(
    (s): s is Speaker => s !== null,
  );
  if (c.VOICE_TTS === "fish" && !fishSpeaker) warnings.push("VOICE_TTS=fish but FISH_API_KEY is not set: using Deepgram");
  const link = (s: Speaker): SpeechLink => ({ provider: s.name, voice: s.voice, model: s.model, endpoint: s.endpoint ?? "" });
  const describe = (s: Speaker) =>
    s.name === "deepgram" ? `deepgram ${s.voice} (${s.model === "flux" ? "Flux TTS" : "Aura-2"}) via ${s.endpoint}, mp3 streamed` : `fish (${s.model}, voice ${s.voice}) via ${s.endpoint}`;
  let lastServed: Speaker | null = null;
  const decisions = new VoiceDecisions();
  const chain = order.length ? withFallThrough(order, log, (s) => (lastServed = s), decisions) : null;
  const tts = chain ? withPhraseCache(withTtsCap(withSpeechTiming(chain, log, () => speakerLabel(lastServed ?? order[0]!)), deps.meters?.tts), 64, 200, order[0]!.voice) : null;
  const claude = usable("ANTHROPIC_API_KEY", c.ANTHROPIC_API_KEY);
  const origin = order[0] ? (order[0].name === "deepgram" ? "https://api.deepgram.com/" : "https://api.fish.audio/") : null;
  const doFetch = deps.fetch ?? providerFetch;
  let lastWarm = 0;
  const pinnedChains = new Map<string, ReturnType<typeof withFallThrough>>();
  return {
    stt,
    tts,
    chain,
    decisions,
    meters: deps.meters ?? null,
    pinned(wanted) {
      const same = order.filter((s) => s.voice === wanted);
      if (same.length === 0) return null;
      let p = pinnedChains.get(wanted);
      if (!p) pinnedChains.set(wanted, (p = withTtsCap(withFallThrough(same, log, (s) => (lastServed = s), decisions), deps.meters?.tts)));
      return p;
    },
    speech: { chain: order.map(link), lastServedBy: () => (lastServed ? link(lastServed) : null) },
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
      speech: order.length ? describe(order[0]!) : "none: replies are shown, not spoken (Glance never uses the browser's voice)",
      speechFallbacks:
        order.length > 1
          ? `${order.map((s, i) => `${speakerLabel(s)} [${(i === 0 ? PRIMARY_FIRST_BYTE_TIMEOUT_MS : SPEECH_FIRST_BYTE_TIMEOUT_MS) / 1000}s]`).join(" -> ")}, on 401/402/429, a first-byte timeout or a connection error; never mid-reply`
          : "none",
      intent: claude ? `claude (${c.INTENT_MODEL}), validated` : "rules parser, validated (set ANTHROPIC_API_KEY for Claude)",
      warnings,
    },
  };
}
