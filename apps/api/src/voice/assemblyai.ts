/**
 * AssemblyAI Universal-Streaming (streaming speech-to-text v3), Glance's speech recognition.
 *
 * Protocol (assemblyai.com/docs/streaming: message-sequence, api-spec/streaming-websocket, prompting-and-keyterms):
 *   connect   wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&speech_model=<model>
 *             &format_turns=true&keyterms_prompt=<JSON array>, with `Authorization: <key>` (no "Bearer"). The key stays
 *             on this server: the extension streams its audio to our /voice/stream, and we stream it on.
 *   Begin     {type, id, expires_at, configuration}: the session is open (audio is held until it arrives)
 *   audio     binary frames of raw 16kHz 16-bit mono PCM, 50 to 1000ms each (error 3007 otherwise), in real time.
 *             The extension captures 40ms slices, so they go out in frames of at least 50ms; the last is padded.
 *   Turn      {turn_order, transcript, end_of_turn, turn_is_formatted, ...}: partials (end_of_turn false) replace each
 *             other; a turn's final is end_of_turn true and formatted ("Buy $10 of Tesla.")
 *   release   {"type":"ForceEndpoint"}: the current turn ends now, without waiting for silence (push-to-talk)
 *   end       {"type":"Terminate"}, then read until {type:"Termination", audio_duration_seconds,
 *             session_duration_seconds} (sessions are billed on session_duration_seconds, which the daily cap counts)
 *   errors    {type:"Error", error_code, error} then a close with that code: 1008 unauthorised (bad key, no balance),
 *             3009 too many concurrent sessions, 3005/1011 server errors, 3007/3006 our mistakes.
 *
 * Model: universal-3-5-pro, AssemblyAI's recommended streaming model: "Fastest" latency and "Best" entity accuracy in
 * their comparison (tickers and company names are entities), native end-of-turn detection, and formatted finals
 * (numbers and currency as digits, which our parser reads directly). universal-streaming-english is "Fast" with
 * "Okay" entity accuracy. ASSEMBLYAI_MODEL overrides it.
 */
import type { AaiOpened, AaiSessionUse, DailyMeter } from "./dailyCaps.js";
import { ProviderError, type ListenMeta, type LiveTranscription, type StreamHooks, type Transcriber, type Transcript } from "./providers.js";

/** The extension's audio: 16kHz, 16-bit, mono (providers.ts STREAM_SAMPLE_RATE; not imported, which would be a cycle at load). */
const STREAM_SAMPLE_RATE = 16_000;

export const ASSEMBLYAI_STREAM_URL = "wss://streaming.assemblyai.com/v3/ws";
export const DEFAULT_ASSEMBLYAI_MODEL = "universal-3-5-pro";
/** 50ms of 16kHz 16-bit mono: AssemblyAI's smallest frame. */
export const MIN_FRAME_BYTES = (STREAM_SAMPLE_RATE * 2) / 20;
/** 1000ms: its largest. */
export const MAX_FRAME_BYTES = STREAM_SAMPLE_RATE * 2;
/** No Begin within this long: the session didn't open (fall back). */
export const BEGIN_TIMEOUT_MS = 3_000;
/** After the release, the longest wait for the turn's final. */
export const FINISH_TIMEOUT_MS = 2_500;
/** At the release, a turn that had already ended gets this long for any speech after it to show up. */
const QUIET_SETTLE_MS = 350;
/** After Terminate, the longest wait for Termination before the socket is closed anyway. */
const TERMINATION_WAIT_MS = 2_000;
/**
 * A session opened ahead of time (/voice/warm for the key going down, or conversation mode starting; never for the
 * panel opening) waits this long for a stream to take it, then ends. It is billed while it waits, so it counts against
 * the daily seconds too (and is logged as wasted when nothing took it).
 */
export const WARM_HOLD_MS = 5_000;
/** One spare per browser (repeat warm calls reuse it), and never more than this many at once in all. */
export const MAX_SPARES = 2;

type WebSocketCtor = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;

export interface AssemblyAiOptions {
  apiKey: string;
  model: string;
  /** For tests: a fake server. */
  url?: string;
  WebSocket?: WebSocketCtor;
  now?: () => number;
  /** Streaming seconds today (ASSEMBLYAI_STT_SECONDS_PER_DAY), counted as AssemblyAI bills: session wall-clock. */
  meter?: DailyMeter | null;
  beginTimeoutMs?: number;
  finishTimeoutMs?: number;
  /** For tests: how long an unused warm session is held (WARM_HOLD_MS). */
  warmHoldMs?: number;
  /** Each session as it closes: why it opened, the seconds billed, and whether it carried speech. */
  onSession?: (use: AaiSessionUse) => void;
}

export function assemblyAiQuery(model: string, keyterms: readonly string[]): string {
  const q = new URLSearchParams({ sample_rate: String(STREAM_SAMPLE_RATE), encoding: "pcm_s16le", speech_model: model, format_turns: "true" });
  if (keyterms.length) q.set("keyterms_prompt", JSON.stringify(keyterms));
  return q.toString();
}

interface AaiMessage {
  type?: string;
  turn_order?: number;
  transcript?: string;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
  error_code?: number;
  error?: string;
  session_duration_seconds?: number;
  configuration?: { model?: string };
}

/** An AssemblyAI close or error code, as the fall-through rules read it (401/429 fall through; so do connection errors). */
export function aaiError(code: number | undefined, message: string): ProviderError {
  // 1008 is any refusal at the door: a bad key, or an account issue (balance, a disabled account). The reason is kept
  // (it's AssemblyAI's own words, never the key) so the log says which.
  // Measured: "Too many concurrent sessions" also arrives as 1008 (not only 3009). It's a rate limit, not a bad key.
  if (code === 1008 && /concurrent/i.test(message)) return new ProviderError("assemblyai", 429, `AssemblyAI: too many concurrent sessions (1008)`);
  if (code === 1008) return new ProviderError("assemblyai", 401, `AssemblyAI refused the session (1008: ${message.slice(0, 100)})`);
  if (code === 3009) return new ProviderError("assemblyai", 429, "AssemblyAI: too many concurrent sessions (3009)");
  return new ProviderError("assemblyai", 0, `AssemblyAI closed the session${code ? ` (${code})` : ""}: ${message.slice(0, 80)}`, "connection");
}

export function assemblyai(opts: AssemblyAiOptions): Transcriber {
  const WS = opts.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor);
  const now = opts.now ?? (() => performance.now());
  const url = opts.url ?? ASSEMBLYAI_STREAM_URL;
  const beginTimeoutMs = opts.beginTimeoutMs ?? BEGIN_TIMEOUT_MS;
  const finishTimeoutMs = opts.finishTimeoutMs ?? FINISH_TIMEOUT_MS;
  const open = (keyterms: readonly string[]) => new WS(`${url}?${assemblyAiQuery(opts.model, keyterms)}`, { headers: { Authorization: opts.apiKey } });

  const used = (u: AaiSessionUse) => {
    opts.meter?.add(u.seconds);
    opts.onSession?.(u);
  };
  type Spare = { ws: WebSocket; started: number; began: boolean; beganAt: number; keyterms: string; timer: ReturnType<typeof setTimeout> };
  /** Sessions opened ahead of time, one per browser (ListenMeta.client), for that browser's next stream to take. */
  const spares = new Map<string, Spare>();
  /** Streams open right now, per browser: while one is, that browser gets no spare (the stream has its session). */
  const active = new Map<string, number>();
  const clientOf = (meta?: ListenMeta) => meta?.client ?? "";
  const dropSpare = (client: string) => {
    const s = spares.get(client);
    if (!s) return;
    clearTimeout(s.timer);
    spares.delete(client);
    try {
      if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "Terminate" }));
      s.ws.close();
    } catch {
      // closed
    }
    used({ opened: "warm", seconds: (now() - s.started) / 1000, speech: false });
  };
  const takeSpare = (client: string) => {
    const s = spares.get(client);
    if (!s || s.ws.readyState > 1) {
      if (s) dropSpare(client);
      return null;
    }
    clearTimeout(s.timer);
    spares.delete(client);
    return s;
  };

  return {
    name: "assemblyai",
    model: opts.model,
    turnDetection: true,
    warm(keyterms, meta) {
      // Billed from the moment it opens: only for a key going down, conversation mode starting, or the panel opening.
      if (!meta?.opened) return;
      const client = clientOf(meta);
      if ((active.get(client) ?? 0) > 0 || (spares.get(client)?.ws.readyState ?? 9) <= 1 || spares.size >= MAX_SPARES) return;
      const ws = open(keyterms);
      ws.binaryType = "arraybuffer";
      const s: Spare = { ws, started: now(), began: false, beganAt: 0, keyterms: JSON.stringify(keyterms), timer: setTimeout(() => dropSpare(client), opts.warmHoldMs ?? WARM_HOLD_MS) };
      ws.onmessage = (m) => {
        try {
          if ((JSON.parse(String(m.data)) as { type?: string }).type === "Begin") {
            s.began = true;
            s.beganAt = now();
          }
        } catch {
          // not JSON
        }
      };
      ws.onerror = () => {
        if (spares.get(client) === s) dropSpare(client);
      };
      ws.onclose = () => {
        if (spares.get(client) === s) dropSpare(client);
      };
      spares.set(client, s);
    },
    async transcribe() {
      // Streaming only (it refuses audio faster than real time): a whole recording goes to the fallback provider.
      throw new ProviderError("assemblyai", 0, "AssemblyAI is used for live streams only", "connection");
    },
    stream(keyterms, hooks: StreamHooks = {}, meta?: ListenMeta): LiveTranscription {
      // A session opened ahead of time, if there is one (its keyterms are brought up to date); else a new one.
      const client = clientOf(meta);
      const warm = takeSpare(client);
      const opened: AaiOpened = warm ? "warm" : meta?.opened === "conversation" ? "conversation" : "key-down";
      active.set(client, (active.get(client) ?? 0) + 1);
      let counted = true;
      const release = () => {
        if (!counted) return;
        counted = false;
        const n = (active.get(client) ?? 1) - 1;
        if (n > 0) active.set(client, n);
        else active.delete(client);
      };
      const started = warm?.started ?? now();
      const ws = warm?.ws ?? open(keyterms);
      ws.binaryType = "arraybuffer";
      let began = warm?.began ?? false;
      let beganAt = warm?.beganAt ?? 0;
      const warmAt = warm ? now() : 0;
      if (warm && warm.keyterms !== JSON.stringify(keyterms) && ws.readyState === 1 && began) ws.send(JSON.stringify({ type: "UpdateConfiguration", keyterms_prompt: keyterms }));
      let failed: ProviderError | null = null;
      let done = false;
      let terminated = false;
      let metered = false;
      const turns = new Map<number, { text: string; final: boolean }>();
      const queued: Uint8Array[] = [];
      let carry = new Uint8Array(0);
      let finishing: { resolve(t: Transcript): void; reject(e: Error): void; releasedAt: number; lastTurn: number } | null = null;
      let finishTimer: ReturnType<typeof setTimeout> | undefined;
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      const beginTimer = began ? undefined : setTimeout(() => fail(new ProviderError("assemblyai", 0, `AssemblyAI didn't open a session within ${beginTimeoutMs}ms`, "timeout")), beginTimeoutMs);

      const text = (withPartial: boolean) =>
        [...turns.entries()]
          .sort((a, b) => a[0] - b[0])
          .filter(([, t]) => t.final || withPartial)
          .map(([, t]) => t.text.trim())
          .filter(Boolean)
          .join(" ");
      const lastOrder = () => Math.max(-1, ...turns.keys());

      const meter = (seconds: number) => {
        if (metered) return;
        metered = true;
        used({ opened, seconds: Math.max(0, seconds), speech: Boolean(text(true)) });
      };
      const close = () => {
        release();
        clearTimeout(terminationTimer);
        meter((now() - started) / 1000);
        try {
          ws.close();
        } catch {
          // already closed
        }
      };
      /** Ends the session properly: Terminate, then wait for Termination (with its billed duration) before closing. */
      const terminate = () => {
        if (terminated) return;
        terminated = true;
        release();
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "Terminate" }));
          terminationTimer = setTimeout(close, TERMINATION_WAIT_MS);
        } else close();
      };
      const sendFrame = (frame: Uint8Array) => {
        if (began && ws.readyState === 1) ws.send(frame);
        else queued.push(frame);
      };
      /** Audio out in frames of 50ms to 1000ms. `flush`: the last of it, padded with silence to 50ms. */
      const push = (chunk: Uint8Array, flush = false) => {
        const all = new Uint8Array(carry.byteLength + chunk.byteLength);
        all.set(carry);
        all.set(chunk, carry.byteLength);
        let at = 0;
        while (all.byteLength - at >= MIN_FRAME_BYTES) {
          const size = Math.min(MAX_FRAME_BYTES, all.byteLength - at);
          sendFrame(all.subarray(at, at + size - (size % 2)));
          at += size - (size % 2);
        }
        carry = all.slice(at);
        if (flush && carry.byteLength > 0) {
          const padded = new Uint8Array(MIN_FRAME_BYTES);
          padded.set(carry);
          sendFrame(padded);
          carry = new Uint8Array(0);
        }
      };
      const settle = (best = false) => {
        if (done || !finishing) return;
        done = true;
        clearTimeout(finishTimer);
        clearTimeout(quietTimer);
        const words = text(best);
        const ready = warm && warm.began ? 0 : Math.round(Math.max(0, beganAt - (warm ? warmAt : started)));
        finishing.resolve({ provider: "assemblyai", text: words, confidence: words ? 0.9 : 0, timing: { connectMs: ready, warm: Boolean(warm?.began), releaseToFinalMs: Math.round(now() - finishing.releasedAt) } });
        terminate();
      };
      function fail(err: ProviderError) {
        if (done || failed) return;
        failed = err;
        clearTimeout(beginTimer);
        if (finishing) {
          // Words already heard are better than none: only fail when there are none.
          if (text(true)) return settle(true);
          done = true;
          clearTimeout(finishTimer);
          finishing.reject(err);
        } else hooks.onFail?.(err);
        close();
      }

      ws.onmessage = (m) => {
        let msg: AaiMessage;
        try {
          msg = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as ArrayBuffer)) as AaiMessage;
        } catch {
          return;
        }
        if (msg.type === "Begin") {
          began = true;
          beganAt = now();
          clearTimeout(beginTimer);
          if (warm && warm.keyterms !== JSON.stringify(keyterms)) ws.send(JSON.stringify({ type: "UpdateConfiguration", keyterms_prompt: keyterms }));
          for (const f of queued.splice(0)) if (ws.readyState === 1) ws.send(f);
          if (finishing && ws.readyState === 1) ws.send(JSON.stringify({ type: "ForceEndpoint" }));
        } else if (msg.type === "Turn") {
          const order = msg.turn_order ?? 0;
          // A turn's final is formatted (Universal-Streaming also sends an unformatted final first: wait for the other).
          const final = Boolean(msg.end_of_turn && msg.turn_is_formatted);
          if (turns.get(order)?.final && !final) return;
          turns.set(order, { text: msg.transcript ?? "", final });
          if (!done) hooks.onPartial?.(text(true));
          if (finishing && !done) {
            clearTimeout(quietTimer);
            if (final && order >= finishing.lastTurn) settle();
          } else if (final && (msg.transcript ?? "").trim()) hooks.onEndOfTurn?.();
        } else if (msg.type === "Error") {
          fail(aaiError(msg.error_code, msg.error ?? "error"));
        } else if (msg.type === "Termination") {
          meter(msg.session_duration_seconds ?? (now() - started) / 1000);
          close();
        }
      };
      ws.onerror = () => fail(new ProviderError("assemblyai", 0, "AssemblyAI's stream couldn't be reached", "connection"));
      ws.onclose = (e) => {
        clearTimeout(beginTimer);
        meter((now() - started) / 1000);
        if (!done && !terminated) fail(aaiError(e.code, e.reason || "closed"));
      };

      return {
        get turnDetection() {
          return true;
        },
        send(chunk) {
          if (failed || done || finishing) return;
          push(chunk);
        },
        finish() {
          return new Promise<Transcript>((resolve, reject) => {
            if (failed && !text(true)) return reject(failed);
            finishing = { resolve, reject, releasedAt: now(), lastTurn: lastOrder() };
            if (failed) return settle(true);
            push(new Uint8Array(0), true);
            if (began && ws.readyState === 1) ws.send(JSON.stringify({ type: "ForceEndpoint" }));
            // The last turn had already ended before the release: only speech after it can add anything.
            const last = turns.get(lastOrder());
            if (last?.final) {
              finishing.lastTurn = lastOrder() + 1;
              quietTimer = setTimeout(() => settle(), QUIET_SETTLE_MS);
            }
            finishTimer = setTimeout(() => (began ? settle(true) : fail(new ProviderError("assemblyai", 0, "AssemblyAI didn't answer in time", "timeout"))), finishTimeoutMs);
          });
        },
        abort() {
          if (done) return;
          done = true;
          clearTimeout(beginTimer);
          clearTimeout(finishTimer);
          clearTimeout(quietTimer);
          terminate();
        },
      };
    },
  };
}
