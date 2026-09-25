/**
 * The voice worker, run by Glance's offscreen document for every surface (the floating orb, the docked side panel,
 * the settings test). It never runs in a web page.
 *
 *   key down   warm the API's provider connections (/voice/warm), check the microphone, open a WebSocket to the
 *              API's /voice/stream, and stream raw 16kHz PCM in 40ms slices as it is captured (an AudioWorklet: no
 *              encoder buffering, and a format the API's warm Deepgram connection can take utterance after utterance)
 *   key up     flush the capture, send {"type":"stop"} (the API ends the turn at once: AssemblyAI's ForceEndpoint, or
 *              Deepgram's Finalize), and get the transcript. If the stream couldn't open, POST the recording as WAV to
 *              /voice/transcribe instead
 *   meanwhile  {"type":"partial"} messages carry the words so far (AssemblyAI partials) to the panel
 *   conversation mode (a setting): one tap starts; there is no key up. The API sends the transcript when the speaker's
 *              turn ends (AssemblyAI's end-of-turn), and the session carries on from there as if released. Escape
 *              aborts. Listening stops after the reply: the microphone is never left on.
 *   then       POST the transcript to /voice/command (intent + one-sentence reply), and play the reply from
 *              GET /voice/speak (Deepgram Aura), streamed into a MediaSource so it starts playing on the first chunks
 *
 * Fallback: only if the Glance API can't be reached, or has no transcription provider, the browser's own speech
 * recognition is used instead (input only), and a "fallback" event says so, so the panel can say it plainly.
 *
 * Replies are only ever spoken in Glance's own voice (the API's /voice/speak). Never the browser's speech synthesis:
 *   - no voice at all (the API down, or no speech provider): the text is shown, a soft tone plays, nothing is said
 *   - the audio stops after it started (no progress for STALL_MS, or an error): it stops there ("cut"), and the page
 *     shows the rest as text. A reply is never finished in another voice.
 *   - the common lines with no values in them (@glance/core/persona FIXED_LINES) are fetched once per session and
 *     replayed from memory (keyed by the voice the API reports).
 * Every browser dependency is injected, so this is unit tested.
 */
import type { Listener, ListenHandlers } from "./voice";
import type { FallbackReason, ListenOptions, SpeechEvent, VoiceCommandContext, VoiceEvent, VoiceIntent, VoiceTiming } from "./voiceMessages";
import type { VoiceCode } from "./voiceReasons";
import { ACKS, FIXED_LINES } from "@glance/core/persona";
import { isSlowRequest } from "@glance/core/showme";

const FIXED = new Set(FIXED_LINES);

type EventBody = VoiceEvent extends infer E ? (E extends VoiceEvent ? Omit<E, "kind" | "session" | "seq"> : never) : never;

export interface WorkerDeps {
  fetch: typeof fetch;
  WebSocket: new (url: string) => WebSocket;
  getUserMedia(): Promise<MediaStream>;
  /**
   * Captures the microphone as 16-bit PCM at 16kHz, calling onChunk with each slice as it is recorded. Resolves once
   * capturing has started; the returned stop() flushes the last slice before it resolves.
   */
  capturePcm(stream: MediaStream, onChunk: (pcm: Uint8Array) => void): Promise<{ stop(): Promise<void> }>;
  /** Creates the element a reply plays in. */
  createAudio(): HTMLAudioElement;
  /**
   * Points the element at a URL whose MP3 streams in, so playback starts on the first chunks rather than when the
   * whole file has arrived (MediaSource). Absent (tests, or no MediaSource): the element loads the URL itself.
   */
  streamInto?(el: HTMLAudioElement, url: string, onVoice?: (voice: string | null) => void): Promise<void>;
  /**
   * getUserMedia failed with this error name: what to tell the user (the background decides from what it remembers:
   * enable voice, the browser's grant ran out, no microphone). See lib/voicePrefs.ts.
   */
  micFailed(errorName: string): Promise<VoiceCode>;
  /** The microphone opened: remembered, so voice stays on. */
  micWorked(): void;
  /** The browser's speech recognition, for the fallback only. */
  listen(lang: string, h: ListenHandlers): Listener | null;
  /** A soft tone for "no voice right now" (the text is shown; nothing is said). */
  errorTone(): void;
  /** An object URL for a whole clip (a pre-recorded line). */
  objectUrl(blob: Blob): string;
  /** Debug only: which voice spoke a reply (never the text). */
  debug?(line: string): void;
  emit(e: VoiceEvent | SpeechEvent): void;
  now(): number;
}

/** How long the API has to answer /voice/status before we treat it as unreachable and fall back. */
export const STATUS_TIMEOUT_MS = 800;
/** How long the stream may take to open before the recording is uploaded whole instead. */
export const STREAM_OPEN_GRACE_MS = 1_500;
const TRANSCRIPT_TIMEOUT_MS = 6_000;
/** Playback that makes no progress for this long, after it started, has stalled: the reply stops there. */
export const STALL_MS = 2_500;
const STATUS_TTL_MS = 30_000;

interface Status {
  reachable: boolean;
  transcription: boolean;
  speech: boolean;
  stream: boolean;
  /** The configured voice (the pre-recorded lines are kept per voice). */
  voice: string | null;
  /** Today's cap on that direction is used up: "Voice is resting for today. You can still type." */
  resting?: { transcription: boolean; speech: boolean };
}

interface Session {
  id: string;
  seq: number;
  api: string;
  context: VoiceCommandContext;
  vault?: string;
  lang: string;
  mode: "server" | "browser";
  /** Conversation mode: the API's end of turn stands in for the key's release. */
  conversation: boolean;
  pending: "stop" | "abort" | null;
  stream?: MediaStream;
  capture?: { stop(): Promise<void> };
  capturing: boolean;
  chunks: Uint8Array[];
  ws?: WebSocket;
  /** The API said today's listening is used up. */
  resting?: boolean;
  wsOpen?: Promise<boolean>;
  transcript?: Promise<string | null>;
  listener?: Listener | null;
  released: number;
  ended: boolean;
}

const httpToWs = (api: string) => api.replace(/^http/, "ws");

/** 16-bit PCM slices -> one WAV file (16kHz mono), for the whole-recording upload. */
export function wav(chunks: Uint8Array[], sampleRate = 16_000): Blob {
  const size = chunks.reduce((n, c) => n + c.byteLength, 0);
  const h = new DataView(new ArrayBuffer(44));
  const text = (at: number, s: string) => [...s].forEach((ch, i) => h.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  h.setUint32(4, 36 + size, true);
  text(8, "WAVE");
  text(12, "fmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true); // PCM
  h.setUint16(22, 1, true); // mono
  h.setUint32(24, sampleRate, true);
  h.setUint32(28, sampleRate * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  text(36, "data");
  h.setUint32(40, size, true);
  return new Blob([h.buffer, ...chunks.map((c) => c.slice().buffer)], { type: "audio/wav" });
}

/** Float samples (-1..1) -> 16-bit little-endian PCM. */
export function toPcm16(samples: Float32Array): Uint8Array {
  const out = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    out.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

export class VoiceWorker {
  private sessions = new Map<string, Session>();
  private status: { at: number; api: string; value: Status } | null = null;
  private playing: { el: HTMLAudioElement; id: string } | null = null;

  constructor(private readonly d: WorkerDeps) {}

  private emit(s: Session, body: EventBody) {
    if (s.ended) return;
    s.seq++;
    this.d.emit({ kind: "voice:event", session: s.id, seq: s.seq, ...body } as VoiceEvent);
    if (body.type === "end") {
      s.ended = true;
      this.sessions.delete(s.id);
    }
  }

  /** The API's voice status, cached briefly. Unreachable within STATUS_TIMEOUT_MS counts as unreachable. */
  async apiStatus(api: string): Promise<Status> {
    if (this.status && this.status.api === api && this.d.now() - this.status.at < STATUS_TTL_MS) return this.status.value;
    let value: Status;
    try {
      const res = await this.d.fetch(`${api}/voice/status`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      const body = (await res.json()) as {
        available?: { transcription?: boolean; speech?: boolean; stream?: boolean };
        speechChain?: Array<{ voice?: string }>;
        resting?: { transcription?: boolean; speech?: boolean };
      };
      value = {
        reachable: res.ok,
        transcription: Boolean(body.available?.transcription),
        speech: Boolean(body.available?.speech),
        stream: Boolean(body.available?.stream),
        voice: body.speechChain?.[0]?.voice ?? null,
        resting: { transcription: Boolean(body.resting?.transcription), speech: Boolean(body.resting?.speech) },
      };
    } catch {
      value = { reachable: false, transcription: false, speech: false, stream: false, voice: null };
    }
    // Don't remember an outage for long: the API may just be starting.
    this.status = { at: value.reachable ? this.d.now() : this.d.now() - STATUS_TTL_MS + 3_000, api, value };
    return value;
  }

  /** Asks the API to warm its provider connections (fire and forget). Called on key down and when the panel opens. */
  warm(api: string) {
    void this.d.fetch(`${api}/voice/warm`, { method: "POST", signal: AbortSignal.timeout(2_000) }).catch(() => {});
  }

  async start(id: string, lang: string, api: string, context: VoiceCommandContext, vault?: string, listen: ListenOptions = {}) {
    this.hush();
    this.warm(api);
    const s: Session = { id, seq: 0, api, context, vault, lang, mode: "server", conversation: Boolean(listen.conversation), pending: null, chunks: [], capturing: false, released: 0, ended: false };
    this.sessions.set(id, s);

    // The microphone is simply tried (a "prompt" from permissions.query isn't trusted): the permission was granted to
    // the extension's origin once, and this document shares it. Only a real failure says anything.
    const [status, mic] = await Promise.all([
      this.apiStatus(api),
      this.d.getUserMedia().then(
        (stream) => ({ stream, error: null }),
        (err: unknown) => ({ stream: null, error: String((err as DOMException)?.name ?? "Error") }),
      ),
    ]);
    if (mic.error !== null) {
      this.emit(s, { type: "error", code: await this.d.micFailed(mic.error).catch(() => "mic-denied" as VoiceCode) });
      return this.emit(s, { type: "end" });
    }
    this.d.micWorked();
    if (s.pending === "abort") {
      mic.stream!.getTracks().forEach((t) => t.stop());
      return this.emit(s, { type: "end" });
    }
    if (status.resting?.transcription) {
      // Today's listening is used up: say so in text, and typing still works.
      mic.stream!.getTracks().forEach((t) => t.stop());
      this.emit(s, { type: "error", code: "voice-resting" });
      return this.emit(s, { type: "end" });
    }
    if (!status.reachable || !status.transcription) {
      mic.stream!.getTracks().forEach((t) => t.stop()); // the browser's recognition opens its own
      return this.startBrowser(s, status.reachable ? "no-provider" : "api-unreachable");
    }
    s.stream = mic.stream!;

    // The stream to the API opens alongside the capture; audio captured before it opens is sent once it does.
    if (status.stream) {
      const params = new URLSearchParams();
      if (s.vault) params.set("vault", s.vault);
      if (s.conversation) params.set("mode", "conversation");
      if (listen.keyterms?.length) params.set("keyterms", JSON.stringify(listen.keyterms.slice(0, 10)));
      const q = params.size ? `?${params.toString()}` : "";
      const ws = new this.d.WebSocket(`${httpToWs(api)}/voice/stream${q}`);
      ws.binaryType = "arraybuffer";
      s.ws = ws;
      s.wsOpen = new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
        ws.onclose = () => resolve(false);
      });
      s.transcript = new Promise<string | null>((resolve) => {
        ws.onmessage = (m) => {
          try {
            const msg = JSON.parse(String(m.data)) as { type?: string; text?: string; endOfTurn?: boolean };
            // The words so far (AssemblyAI's partials), for the panel's live transcript.
            if (msg.type === "partial") return this.emit(s, { type: "interim", text: msg.text ?? "" });
            if (msg.type === "transcript") {
              resolve(msg.text ?? "");
              // Conversation mode: the speaker's turn ended, so the session goes on as if the key were released.
              if (msg.endOfTurn && s.conversation && s.capturing) void this.stop(id);
            }
            else if (msg.type === "error") {
              if ((msg as { code?: string }).code === "VOICE_RESTING") s.resting = true;
              resolve(null);
            }
          } catch {
            // ignore
          }
        };
        void s.wsOpen!.then((ok) => {
          if (!ok) resolve(null);
          ws.addEventListener("close", () => resolve(null));
        });
      });
    }

    try {
      s.capture = await this.d.capturePcm(s.stream, (pcm) => {
        s.chunks.push(pcm);
        void this.forward(s, pcm);
      });
    } catch {
      s.stream.getTracks().forEach((t) => t.stop());
      this.emit(s, { type: "error", code: "audio-capture" });
      return this.emit(s, { type: "end" });
    }
    s.capturing = true;
    this.emit(s, { type: "started" });
    if (s.pending === "stop") void this.stop(id);
    else if (s.pending === "abort") this.abort(id);
  }

  /** Sends a chunk down the stream, in order, once it is open. */
  private sendQueue = Promise.resolve();
  private forward(s: Session, chunk: Uint8Array) {
    if (!s.ws || !s.wsOpen) return;
    const ws = s.ws;
    this.sendQueue = this.sendQueue.then(async () => {
      if (!(await s.wsOpen)) return;
      if (ws.readyState === 1) ws.send(chunk as Uint8Array<ArrayBuffer>);
    });
    return this.sendQueue;
  }

  private startBrowser(s: Session, reason: FallbackReason) {
    s.mode = "browser";
    this.emit(s, { type: "fallback", reason });
    s.listener = this.d.listen(s.lang, {
      onStart: () => {
        this.emit(s, { type: "started" });
        if (s.pending === "stop") s.listener?.stop();
      },
      onInterim: (text) => this.emit(s, { type: "interim", text }),
      onFinal: (text) => {
        this.emit(s, { type: "timing", timing: { transcript: s.released ? this.d.now() - s.released : 0, via: "browser" } });
        this.emit(s, { type: "final", text });
      },
      onError: (code) => this.emit(s, { type: "error", code }),
      onEnd: () => this.emit(s, { type: "end" }),
    });
    if (s.listener && s.pending === "abort") s.listener.abort();
  }

  async stop(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.mode === "browser") {
      s.released = this.d.now();
      this.emit(s, { type: "released" });
      if (s.listener) s.listener.stop();
      else s.pending = "stop";
      return;
    }
    if (!s.capturing) {
      s.pending = "stop"; // released before capture started: stop as soon as it does
      return;
    }
    s.capturing = false;
    s.released = this.d.now();
    this.emit(s, { type: "released" });
    await s.capture!.stop();
    s.stream?.getTracks().forEach((t) => t.stop());
    await this.sendQueue;

    let text: string | null = null;
    let via: VoiceTiming["via"] = "stream";
    if (s.ws && (await Promise.race([s.wsOpen!, new Promise<boolean>((r) => setTimeout(() => r(false), STREAM_OPEN_GRACE_MS))]))) {
      if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "stop" }));
      text = await Promise.race([s.transcript!, new Promise<null>((r) => setTimeout(() => r(null), TRANSCRIPT_TIMEOUT_MS))]);
    }
    if (text === null) {
      via = "upload";
      s.ws?.close();
      try {
        const res = await this.d.fetch(`${s.api}/voice/transcribe`, {
          method: "POST",
          headers: { "content-type": "audio/wav" },
          body: wav(s.chunks),
          signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT_MS),
        });
        if (res.ok) text = ((await res.json()) as { text?: string }).text ?? "";
      } catch {
        text = null;
      }
    }
    const timing: VoiceTiming = { transcript: this.d.now() - s.released, via };
    if (text === null) {
      this.emit(s, { type: "error", code: s.resting ? "voice-resting" : "transcription-failed" });
      return this.emit(s, { type: "end" });
    }
    this.emit(s, { type: "final", text });
    if (!text.trim()) {
      this.emit(s, { type: "timing", timing });
      return this.emit(s, { type: "end" });
    }
    // A request that takes Claude a moment (Show me, teach, guide, why): an instant "One sec." in Glance's voice,
    // pre-recorded, while the answer is worked out. Prices, the portfolio and buys get none: they should just be fast.
    if (isSlowRequest(text)) void this.speak(`ack-${s.id}`, ACKS[this.ackTurn++ % ACKS.length]!, s.api);

    // What was meant, and the reply. If the API can't answer, the page falls back to its own parser (no intent).
    let intent: VoiceIntent | null = null;
    try {
      const res = await this.d.fetch(`${s.api}/voice/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: text, context: s.context, ...(s.vault ? { vault: s.vault } : {}) }),
        signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT_MS),
      });
      if (res.ok) intent = (await res.json()) as VoiceIntent;
    } catch {
      intent = null;
    }
    timing.intent = this.d.now() - s.released;
    if (!intent) {
      this.emit(s, { type: "timing", timing });
      return this.emit(s, { type: "end" });
    }
    this.emit(s, {
      type: "intent",
      intent: { intent: intent.intent, symbol: intent.symbol, amount: intent.amount, reply: intent.reply, ...(intent.symbols ? { symbols: intent.symbols, range: intent.range } : {}) },
    });
    if (!intent.reply.trim()) {
      // Nothing to say here ("ask": the page answers with Show me, and speaks that).
      this.emit(s, { type: "timing", timing });
      return this.emit(s, { type: "end" });
    }
    // The reply is spoken under the session's id, so the page can follow it with the speaking orb.
    const released = s.released;
    void this.speak(s.id, intent.reply, s.api, () => {
      this.emit(s, { type: "timing", timing: { ...timing, speaking: this.d.now() - released } });
      this.emit(s, { type: "end" });
    });
  }

  abort(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.pending = "abort";
    if (s.listener) s.listener.abort();
    const capturing = s.capturing;
    s.capturing = false;
    if (s.capture) void s.capture.stop();
    s.stream?.getTracks().forEach((t) => t.stop());
    s.ws?.close();
    if (capturing || s.capture || s.listener) this.emit(s, { type: "end" });
  }

  /**
   * Speaks `text`: the API's voice (Deepgram Aura, or Fish) when it has one, else the browser's. The "start" event fires when the
   * audio element actually starts playing and "end" when it stops, so the speaking orb moves exactly with the voice.
   * `onStarted` fires once playback begins (or when it's clear nothing will play).
   */
  speak(id: string, text: string, api: string, onStarted?: () => void): Promise<void> {
    // Replies queue: the card's review line waits for "$10 of Tesla…" to finish. A new key press (hush) drops the queue.
    const gen = this.gen;
    this.chain = this.chain.then(() => {
      if (gen !== this.gen) {
        onStarted?.();
        this.d.emit({ kind: "voice:speech", id, type: "unavailable" });
        return;
      }
      return this.play(id, text, api, onStarted);
    });
    return this.chain;
  }

  private chain: Promise<void> = Promise.resolve();
  private gen = 0;

  /** Pre-recorded lines fetched this session, by voice and text. */
  private fixed = new Map<string, Blob>();

  private async play(id: string, text: string, api: string, onStarted?: () => void) {
    let started = false;
    const markStarted = () => {
      if (started) return;
      started = true;
      onStarted?.();
    };
    // No voice: the text is already on screen; a soft tone says there's no voice, and nothing is spoken. The status is
    // read again next time (the voice may be back, or today's cap may have just been reached).
    const unavailable = () => {
      markStarted();
      this.d.errorTone();
      this.status = null;
      this.d.emit({ kind: "voice:speech", id, type: "unavailable", ...(status.resting?.speech ? { resting: true } : {}) });
    };
    let status = await this.apiStatus(api);
    if (!status.speech) {
      // A remembered outage may be stale (the API restarting): ask once more before giving up.
      this.status = null;
      status = await this.apiStatus(api);
    }
    if (!status.speech) return unavailable();

    const url = `${api}/voice/speak?text=${encodeURIComponent(text)}`;
    const el = this.d.createAudio();
    this.playing = { el, id };
    const outcome = await new Promise<"ended" | "cut" | "unavailable">((resolve) => {
      let begun = false;
      let settled = false;
      let lastTime = -1;
      let lastMove = this.d.now();
      let watch: ReturnType<typeof setInterval> | undefined;
      const settle = (o: "ended" | "cut" | "unavailable") => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        if (this.playing?.el === el) this.playing = null;
        resolve(o);
      };
      // After it started, any stop that isn't the natural end is a cut: stop right there, in this voice.
      const cut = () => {
        if (settled) return;
        const t = el.currentTime;
        const d = Number.isFinite(el.duration) ? el.duration : null;
        settle("cut"); // first, so the pause below isn't taken for a normal end
        try {
          el.pause();
        } catch {
          // already stopped
        }
        this.d.emit({ kind: "voice:speech", id, type: "cut", t, d });
      };
      el.onplaying = () => {
        if (begun) return;
        begun = true;
        lastMove = this.d.now();
        markStarted();
        this.d.emit({ kind: "voice:speech", id, type: "start" });
        watch = setInterval(() => {
          if (el.currentTime !== lastTime) {
            lastTime = el.currentTime;
            lastMove = this.d.now();
          } else if (this.d.now() - lastMove > STALL_MS) cut();
        }, 250);
      };
      // Where playback is, for "Show me" (its drawings follow the voice). Duration is null while the audio streams in.
      el.ontimeupdate = () => this.d.emit({ kind: "voice:speech", id, type: "progress", t: el.currentTime, d: Number.isFinite(el.duration) ? el.duration : null });
      el.onended = () => {
        if (begun) this.d.emit({ kind: "voice:speech", id, type: "end" });
        settle(begun ? "ended" : "unavailable");
      };
      // A pause we didn't make (hush makes its own): treat as the end of this reply.
      el.onpause = () => {
        if (settled) return;
        if (begun) this.d.emit({ kind: "voice:speech", id, type: "end" });
        settle(begun ? "ended" : "unavailable");
      };
      el.onerror = () => (begun ? cut() : settle("unavailable"));
      const failed = () => (begun ? undefined : settle("unavailable")); // after it began, the stall watch decides
      void (async () => {
        const key = `${status.voice ?? ""}\n${text}`;
        if (FIXED.has(text.trim())) {
          // A common line: fetched whole once this session, then from memory.
          let blob = this.fixed.get(key);
          if (!blob) {
            const res = await this.d.fetch(url).catch(() => null);
            if (!res?.ok) return failed();
            this.d.debug?.(`[glance] reply voice: ${res.headers.get("x-voice") ?? "?"} (${res.headers.get("x-voice-cache") ?? "live"})`);
            blob = await res.blob();
            this.fixed.set(key, blob);
          } else this.d.debug?.(`[glance] reply voice: ${status.voice ?? "?"} (this session's copy)`);
          el.src = this.d.objectUrl(blob);
        } else if (this.d.streamInto) {
          // Not awaited: play() starts on the first bytes, while the rest streams in.
          void this.d.streamInto(el, url, (voice) => this.d.debug?.(`[glance] reply voice: ${voice ?? "?"}`)).catch(failed);
        } else el.src = url;
      })().then(
        () => void el.play().catch(failed),
        failed,
      );
    });
    if (outcome === "unavailable") unavailable();
  }

  private ackTurn = 0;

  // ---- A reply in parts (Show me, streamed): one sentence at a time, back to back, in one voice ------------------

  private replies = new Map<string, { api: string; parts: string[]; total: number | null; wake: (() => void) | null; running: boolean }>();

  /** A sentence of reply `id`. The first one starts the reply (queued behind anything already speaking). */
  speakPart(id: string, index: number, text: string, api: string) {
    let r = this.replies.get(id);
    if (!r) {
      r = { api, parts: [], total: null, wake: null, running: false };
      this.replies.set(id, r);
    }
    r.parts[index] = text;
    r.wake?.();
    if (!r.running) {
      r.running = true;
      const gen = this.gen;
      const reply = r;
      this.chain = this.chain.then(async () => {
        if (gen === this.gen) await this.playParts(id, reply);
        else this.d.emit({ kind: "voice:speech", id, type: "unavailable" });
      });
    }
  }

  /** No more parts for reply `id`. */
  speakEnd(id: string, total: number) {
    const r = this.replies.get(id);
    if (!r) {
      // Nothing was ever pushed: an empty reply.
      if (total === 0) this.d.emit({ kind: "voice:speech", id, type: "end" });
      return;
    }
    r.total = total;
    r.wake?.();
  }

  /** Part `index`'s text once it has been pushed, or null when the reply ended before it. */
  private async partText(r: { parts: string[]; total: number | null; wake: (() => void) | null }, index: number, gen: number): Promise<string | null> {
    for (;;) {
      if (gen !== this.gen) return null;
      if (r.parts[index] !== undefined) return r.parts[index]!;
      if (r.total !== null && index >= r.total) return null;
      await new Promise<void>((resolve) => {
        r.wake = resolve;
        setTimeout(resolve, 250); // a hush elsewhere also wakes us
      });
      r.wake = null;
    }
  }

  private async playParts(id: string, r: { api: string; parts: string[]; total: number | null; wake: (() => void) | null }) {
    const gen = this.gen;
    const status = await this.apiStatus(r.api);
    const done = (type: "end" | "unavailable") => {
      this.replies.delete(id);
      if (type === "unavailable") {
        this.d.errorTone();
        this.status = null;
        return this.d.emit({ kind: "voice:speech", id, type, ...(status.resting?.speech ? { resting: true } : {}) });
      }
      this.d.emit({ kind: "voice:speech", id, type });
    };
    if (!status.speech) return done("unavailable");
    let voice: string | null = null;
    // Each later part is fetched whole while the one before it plays, pinned to the first part's voice (one retry).
    const fetchPart = async (text: string): Promise<Blob | null> => {
      const url = `${r.api}/voice/speak?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice ?? "")}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await this.d.fetch(url).catch(() => null);
        if (res?.ok) return res.blob();
      }
      return null;
    };
    const preloaded = new Map<number, Promise<Blob | null>>();
    const preload = async (index: number) => {
      if (preloaded.has(index) || voice === null) return;
      const text = await this.partText(r, index, gen);
      if (text === null || preloaded.has(index)) return;
      preloaded.set(index, fetchPart(text));
    };
    for (let index = 0; ; index++) {
      const text = await this.partText(r, index, gen);
      if (text === null) return gen === this.gen ? done(index === 0 ? "unavailable" : "end") : done("end");
      // A later part's audio is ready first (preloaded while the one before played): no element for a part never said.
      const blob = index === 0 ? null : await (preloaded.get(index) ?? fetchPart(text));
      if (index > 0 && !blob) {
        // This voice can't say the next sentence: stop here, in the same voice; the rest stays written.
        this.replies.delete(id);
        this.d.emit({ kind: "voice:speech", id, type: "cut", t: 0, d: null, part: index });
        return;
      }
      const el = this.d.createAudio();
      this.playing = { el, id };
      let setup: (fail: () => void) => Promise<boolean>;
      if (index === 0) {
        // The first part streams, so it starts on the first bytes (play() isn't held for the download); the voice
        // that answers is kept for the rest.
        const url = `${r.api}/voice/speak?text=${encodeURIComponent(text)}`;
        setup = async (fail) => {
          if (this.d.streamInto) {
            void this.d
              .streamInto(el, url, (v) => {
                voice = v;
                void preload(1);
              })
              .catch(fail);
            return true;
          }
          el.src = url;
          voice = status.voice;
          void preload(1);
          return true;
        };
      } else {
        setup = async () => {
          el.src = this.d.objectUrl(blob!);
          void preload(index + 1);
          return true;
        };
      }
      const outcome = await this.playOne(id, el, index, setup);
      if (outcome === "cut") {
        this.replies.delete(id);
        return;
      }
      if (outcome === "unavailable") return done(index === 0 ? "unavailable" : "end");
      if (gen !== this.gen) return done("end");
    }
  }

  /** Plays one part: its own start, progress and end events; a stall or an error after it started is a cut. */
  private playOne(id: string, el: HTMLAudioElement, index: number, setup: (fail: () => void) => Promise<boolean>): Promise<"ended" | "cut" | "unavailable"> {
    return new Promise((resolve) => {
      let begun = false;
      let settled = false;
      let lastTime = -1;
      let lastMove = this.d.now();
      let watch: ReturnType<typeof setInterval> | undefined;
      const settle = (o: "ended" | "cut" | "unavailable") => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        if (this.playing?.el === el) this.playing = null;
        resolve(o);
      };
      const cut = () => {
        if (settled) return;
        const t = el.currentTime;
        const d = Number.isFinite(el.duration) ? el.duration : null;
        settle("cut");
        try {
          el.pause();
        } catch {
          // already stopped
        }
        this.d.emit({ kind: "voice:speech", id, type: "cut", t, d, part: index });
      };
      el.onplaying = () => {
        if (begun) return;
        begun = true;
        lastMove = this.d.now();
        if (index === 0) this.d.emit({ kind: "voice:speech", id, type: "start" });
        this.d.emit({ kind: "voice:speech", id, type: "part", index });
        watch = setInterval(() => {
          if (el.currentTime !== lastTime) {
            lastTime = el.currentTime;
            lastMove = this.d.now();
          } else if (this.d.now() - lastMove > STALL_MS) cut();
        }, 250);
      };
      el.ontimeupdate = () => this.d.emit({ kind: "voice:speech", id, type: "part-progress", index, t: el.currentTime, d: Number.isFinite(el.duration) ? el.duration : null });
      const ended = () => {
        if (settled) return;
        if (begun) this.d.emit({ kind: "voice:speech", id, type: "part-end", index });
        settle(begun ? "ended" : "unavailable");
      };
      el.onended = ended;
      el.onpause = ended;
      el.onerror = () => (begun ? cut() : settle("unavailable"));
      // A failure before the voice started means no voice; after, the stall watch decides (never another voice).
      const fail = () => (begun ? undefined : settle("unavailable"));
      void setup(fail).then(
        (ok) => (ok ? void el.play().catch(fail) : settle("unavailable")),
        () => settle("unavailable"),
      );
    });
  }

  /** Stops any reply that is playing, and drops any queued (a new command, or the user talking over it). */
  hush() {
    this.gen++;
    for (const r of this.replies.values()) r.wake?.();
    this.replies.clear();
    if (!this.playing) return;
    const { el } = this.playing;
    this.playing = null;
    el.pause();
  }
}
