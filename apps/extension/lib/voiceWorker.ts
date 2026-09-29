/**
 * The voice worker, run by Glance's offscreen document for every surface (the floating orb, the docked side panel,
 * the settings test). It never runs in a web page.
 *
 *   key down   warm the API's provider connections and open this browser's AssemblyAI session
 *              (/voice/warm?for=key-down; the panel opening warms only what costs nothing idle), check the microphone,
 *              open a WebSocket to the
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
import { FADE_S, MIN_SLICE_S, mp3FrameEnd, PREFETCH, TAIL_HOLD_S, Timeline, type AudioOut } from "./gapless";
import { mp3SampleRate, VoiceReport, type ChunkTiming } from "./voiceReport";
import { watchLongTasks } from "./workLabel";
import type { Listener, ListenHandlers } from "./voice";
import type { FallbackReason, ListenOptions, SpeechEvent, VoiceCommandContext, VoiceEvent, VoiceIntent, VoiceTiming } from "./voiceMessages";
import type { VoiceCode } from "./voiceReasons";
import { ACKS, FIXED_LINES, LINES } from "@glance/core/persona";
import { isSlowRequest } from "@glance/core/showme";

const FIXED = new Set(FIXED_LINES);

/** A reply in parts: its sentences as they are pushed, and how many there are once known. */
interface Reply {
  api: string;
  parts: string[];
  total: number | null;
  wake: (() => void) | null;
}

/** How long a fallback voice may take to say the rest before it goes on screen instead. */
export const FALLBACK_BUDGET_MS = 1_500;

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
   * An audio output for one answer in sentences (lib/gapless.ts), at the speech's sample rate when known. Absent
   * (tests of the element player, or no Web Audio): each sentence plays in its own element instead.
   */
  audioOut?(sampleRate: number | null): AudioOut;
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
/** The API may try the upload path once after the stream (3.5s at most): the transcript gets this long. */
const TRANSCRIPT_TIMEOUT_MS = 7_000;
/** Held at least this long and nothing heard: "Didn't catch that", shown and said. A shorter tap stays quiet. */
export const NOT_HEARD_MIN_HOLD_MS = 600;
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
  /** The speech chain's voices in order: the first answers while it can, the next is the fallback. */
  voices?: string[];
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
  /** When the key went down (now()), for "held at least 0.6s". */
  downAt: number;
  /** Escape: the turn is dropped. Nothing more is sent, asked or said for it. */
  aborted: boolean;
  /** How many of `chunks` have gone down the stream (audio from before it opened goes first, in order). */
  sent: number;
  notHeard?: string;
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
  /** The answer playing through Web Audio: stop() silences it at once (Escape, the user talking over it). */
  private gapless: { stop(): void } | null = null;

  /**
   * This browser, to the API: a random id for as long as the offscreen document lives. The API keeps at most one warm
   * AssemblyAI session per id, and the stream takes that one.
   */
  readonly client = `g-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;

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
        voices: [...new Set((body.speechChain ?? []).map((l) => l.voice).filter((v): v is string => Boolean(v)))],
        resting: { transcription: Boolean(body.resting?.transcription), speech: Boolean(body.resting?.speech) },
      };
    } catch {
      value = { reachable: false, transcription: false, speech: false, stream: false, voice: null };
    }
    // Don't remember an outage for long: the API may just be starting.
    this.status = { at: value.reachable ? this.d.now() : this.d.now() - STATUS_TTL_MS + 3_000, api, value };
    return value;
  }

  /**
   * Asks the API to warm its provider connections (fire and forget). With `why` (the key went down, conversation mode
   * started, or the panel opened) the API may also open this browser's AssemblyAI session, billed from then on and
   * held 5s (the panel only with ASSEMBLYAI_WARM=panel). The panel's refresh passes nothing: only the connections that
   * cost nothing idle.
   */
  warm(api: string, why?: "key-down" | "conversation" | "panel") {
    const q = why ? `?for=${why}&client=${this.client}` : "";
    void this.d.fetch(`${api}/voice/warm${q}`, { method: "POST", signal: AbortSignal.timeout(2_000) }).catch(() => {});
  }

  async start(id: string, lang: string, api: string, context: VoiceCommandContext, vault?: string, listen: ListenOptions = {}) {
    this.hush();
    this.warm(api, listen.conversation ? "conversation" : "key-down");
    const s: Session = {
      id,
      seq: 0,
      api,
      context,
      vault,
      lang,
      mode: "server",
      conversation: Boolean(listen.conversation),
      pending: null,
      chunks: [],
      capturing: false,
      released: 0,
      ended: false,
      downAt: this.d.now(),
      aborted: false,
      sent: 0,
      notHeard: listen.notHeard,
    };
    this.sessions.set(id, s);

    // The microphone is simply tried (a "prompt" from permissions.query isn't trusted): the permission was granted to
    // the extension's origin once, and this document shares it. Only a real failure says anything.
    const statusP = this.apiStatus(api);
    const mic = await this.d.getUserMedia().then(
      (stream) => ({ stream, error: null }),
      (err: unknown) => ({ stream: null, error: String((err as DOMException)?.name ?? "Error") }),
    );
    if (mic.error !== null) {
      this.emit(s, { type: "error", code: await this.d.micFailed(mic.error).catch(() => "mic-denied" as VoiceCode) });
      return this.emit(s, { type: "end" });
    }
    this.d.micWorked();
    if (s.pending === "abort") {
      mic.stream!.getTracks().forEach((t) => t.stop());
      return this.emit(s, { type: "end" });
    }
    s.stream = mic.stream!;
    // Capture starts the moment the microphone is ours, before anything else is asked: the first word is in the turn's
    // audio even while the API's status and the stream are still on their way (it goes down the stream once open).
    try {
      s.capture = await this.d.capturePcm(s.stream, (pcm) => {
        s.chunks.push(pcm);
        if (s.ws) void this.flush(s);
      });
    } catch {
      s.stream.getTracks().forEach((t) => t.stop());
      this.emit(s, { type: "error", code: "audio-capture" });
      return this.emit(s, { type: "end" });
    }
    const status = await statusP;
    const dropCapture = () => {
      void s.capture?.stop();
      s.capture = undefined;
      s.stream?.getTracks().forEach((t) => t.stop());
    };
    if (s.aborted) return;
    if (status.resting?.transcription) {
      // Today's listening is used up: say so in text, and typing still works.
      dropCapture();
      this.emit(s, { type: "error", code: "voice-resting" });
      return this.emit(s, { type: "end" });
    }
    if (!status.reachable || !status.transcription) {
      dropCapture(); // the browser's recognition opens its own
      s.chunks = [];
      return this.startBrowser(s, status.reachable ? "no-provider" : "api-unreachable");
    }

    // The stream to the API opens alongside the capture; audio captured before it opens is sent once it does.
    if (status.stream) {
      const params = new URLSearchParams();
      if (s.vault) params.set("vault", s.vault);
      params.set("client", this.client);
      if (s.conversation) params.set("mode", "conversation");
      if (listen.keyterms?.length) params.set("keyterms", JSON.stringify(listen.keyterms.slice(0, 10)));
      const q = `?${params.toString()}`;
      const ws = new this.d.WebSocket(`${httpToWs(api)}/voice/stream${q}`);
      ws.binaryType = "arraybuffer";
      s.ws = ws;
      s.wsOpen = new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
        ws.onclose = () => resolve(false);
      });
      // Everything captured so far goes first, then each slice as it comes.
      void this.flush(s);
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

    s.capturing = true;
    this.emit(s, { type: "started" });
    if (s.pending === "stop") void this.stop(id);
    else if (s.pending === "abort") this.abort(id);
  }

  /** Sends what hasn't gone down the stream yet, in order, once it is open (audio from before it opened first). */
  private sendQueue = Promise.resolve();
  private flush(s: Session) {
    if (!s.ws || !s.wsOpen) return;
    const ws = s.ws;
    this.sendQueue = this.sendQueue.then(async () => {
      if (!(await s.wsOpen) || s.aborted) return;
      while (s.sent < s.chunks.length && ws.readyState === 1) ws.send(s.chunks[s.sent++] as Uint8Array<ArrayBuffer>);
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
    if (s.aborted) return;
    void this.flush(s);
    await this.sendQueue;
    if (s.aborted) return;

    let text: string | null = null;
    let via: VoiceTiming["via"] = "stream";
    if (s.ws && (await Promise.race([s.wsOpen!, new Promise<boolean>((r) => setTimeout(() => r(false), STREAM_OPEN_GRACE_MS))]))) {
      if (s.aborted) return;
      if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "stop" }));
      text = await Promise.race([s.transcript!, new Promise<null>((r) => setTimeout(() => r(null), TRANSCRIPT_TIMEOUT_MS))]);
    }
    // Escape while waiting: the turn is dropped (no upload, no command, nothing said).
    if (s.aborted) return;
    // Only when the stream gave no answer at all (it never opened, or went quiet): the API itself already tried the
    // upload path for a stream that answered with nothing, so this never runs alongside a working stream.
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
      if (s.aborted) return;
    }
    const timing: VoiceTiming = { transcript: this.d.now() - s.released, via };
    if (text === null && s.resting) {
      this.emit(s, { type: "error", code: "voice-resting" });
      return this.emit(s, { type: "end" });
    }
    if (!text?.trim()) {
      // Nothing heard. Held long enough to have meant it: never silent ("Didn't catch that", shown and said).
      if (s.released - s.downAt >= NOT_HEARD_MIN_HOLD_MS) {
        this.emit(s, { type: "error", code: "not-heard" });
        void this.speak(`not-heard-${s.id}`, s.notHeard ?? LINES.notHeardSpoken, s.api);
      } else if (text === null) this.emit(s, { type: "error", code: "transcription-failed" });
      else this.emit(s, { type: "final", text: "" });
      this.emit(s, { type: "timing", timing });
      return this.emit(s, { type: "end" });
    }
    this.emit(s, { type: "final", text });
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
    if (s.aborted) return;
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

  /**
   * Escape: a hard stop. The turn is dropped wherever it is: the API is told to cancel (it closes the provider's
   * session cleanly and sends nothing back), and nothing more is uploaded, asked or said for it.
   */
  abort(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    const wasAborted = s.aborted;
    s.aborted = true;
    s.pending = "abort";
    if (s.ws?.readyState === 1) s.ws.send(JSON.stringify({ type: "cancel" }));
    else if (s.ws?.readyState === 0) {
      // Still connecting: say cancel the moment it opens (so the API drops the turn and logs it), then close.
      const ws = s.ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "cancel" }));
        ws.close();
      };
    }
    if (wasAborted) return;
    // Nothing is said for a dropped turn (an "One sec." or a reply already on its way stops too).
    this.hush();
    if (s.listener) s.listener.abort();
    const capturing = s.capturing;
    s.capturing = false;
    if (s.capture) void s.capture.stop();
    s.stream?.getTracks().forEach((t) => t.stop());
    if (s.ws?.readyState !== 0) s.ws?.close();
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

    // Gapless, streamed through Web Audio like a reply in parts (a common line is a short clip from memory instead).
    if (this.d.audioOut && !FIXED.has(text.trim())) {
      return this.playPartsGapless(id, { api, parts: [text], total: 1, wake: null }, status, this.d.audioOut.bind(this.d), { onStarted: markStarted });
    }
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

  private replies = new Map<string, Reply & { running: boolean }>();

  /** A sentence of reply `id`. The first one starts the reply (queued behind anything already speaking). */
  speakPart(id: string, index: number, text: string, api: string) {
    let r = this.replies.get(id);
    if (!r) {
      r = { api, parts: [], total: null, wake: null, running: false };
      this.replies.set(id, r);
    }
    r.api ||= api;
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
      if (total === 0) return this.d.emit({ kind: "voice:speech", id, type: "end" });
      // The end can arrive before its parts (a reply pushed all at once: the parts wait on the API's address in the
      // background, the end doesn't). Kept, so the reply still knows where it ends.
      this.replies.set(id, { api: "", parts: [], total, wake: null, running: false });
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

  private async playParts(id: string, r: Reply) {
    const gen = this.gen;
    const status = await this.apiStatus(r.api);
    if (status.speech && this.d.audioOut) return this.playPartsGapless(id, r, status, this.d.audioOut.bind(this.d));
    const report = new VoiceReport(id, "element", null);
    const sendReport = () => this.d.emit({ kind: "voice:speech", id, type: "report", report: report.summary() });
    // The report follows the end: the page keeps listening a few seconds for it.
    const done = (type: "end" | "unavailable") => {
      report.outcome = type === "end" ? "ended" : "unavailable";
      this.replies.delete(id);
      if (type === "unavailable") {
        this.d.errorTone();
        this.status = null;
        this.d.emit({ kind: "voice:speech", id, type, ...(status.resting?.speech ? { resting: true } : {}) });
      } else this.d.emit({ kind: "voice:speech", id, type });
      sendReport();
    };
    if (!status.speech) return done("unavailable");
    let voice: string | null = null;
    // Each later part is fetched whole while the one before it plays, pinned to the first part's voice (one retry).
    const fetchPart = async (text: string, index: number): Promise<Blob | null> => {
      const url = `${r.api}/voice/speak?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice ?? "")}`;
      const c = report.chunk(index);
      c.requestAt = this.d.now();
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await this.d.fetch(url).catch(() => null);
        if (res?.ok) {
          c.firstByteAt = this.d.now();
          c.model = `${res.headers.get("x-voice") ?? "?"}${res.headers.get("x-voice-cache") === "prerecorded" ? " (prerecorded)" : ""}${attempt ? " (retry)" : ""}`;
          report.voices.add(res.headers.get("x-voice") ?? "?");
          const blob = await res.blob();
          c.readyAt = this.d.now();
          c.sampleRate = mp3SampleRate(new Uint8Array(await blob.slice(0, 4096).arrayBuffer()));
          return blob;
        }
      }
      return null;
    };
    const preloaded = new Map<number, Promise<Blob | null>>();
    const preload = async (index: number) => {
      if (preloaded.has(index) || voice === null) return;
      const text = await this.partText(r, index, gen);
      if (text === null || preloaded.has(index)) return;
      preloaded.set(index, fetchPart(text, index));
    };
    for (let index = 0; ; index++) {
      const text = await this.partText(r, index, gen);
      if (text === null) return gen === this.gen ? done(index === 0 ? "unavailable" : "end") : done("end");
      // A later part's audio is ready first (preloaded while the one before played): no element for a part never said.
      const blob = index === 0 ? null : await (preloaded.get(index) ?? fetchPart(text, index));
      if (index > 0 && !blob) {
        // This voice can't say the next sentence: stop here, in the same voice; the rest stays written.
        report.outcome = "cut";
        this.replies.delete(id);
        this.d.emit({ kind: "voice:speech", id, type: "cut", t: 0, d: null, part: index });
        sendReport();
        return;
      }
      const el = this.d.createAudio();
      this.playing = { el, id };
      let setup: (fail: () => void) => Promise<boolean>;
      if (index === 0) {
        // The first part streams, so it starts on the first bytes (play() isn't held for the download); the voice
        // that answers is kept for the rest.
        const url = `${r.api}/voice/speak?text=${encodeURIComponent(text)}`;
        const c0 = report.chunk(0);
        c0.requestAt = this.d.now();
        setup = async (fail) => {
          if (this.d.streamInto) {
            void this.d
              .streamInto(el, url, (v) => {
                voice = v;
                c0.firstByteAt = this.d.now();
                c0.model = v;
                if (v) report.voices.add(v);
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
      const outcome = await this.playOne(id, el, index, setup, report);
      if (outcome === "cut") {
        report.outcome = "cut";
        this.replies.delete(id);
        sendReport(); // after playOne's own cut event
        return;
      }
      if (outcome === "unavailable") return done(index === 0 ? "unavailable" : "end");
      if (gen !== this.gen) return done("end");
    }
  }

  /**
   * A reply in parts through Web Audio (lib/gapless.ts). Each sentence streams in (N+1 and N+2 are asked for while N
   * plays); as its MP3 arrives, the whole-frame prefix is decoded again and the new samples are scheduled to start
   * exactly where the last ones end, so a long sentence starts before it has finished arriving and the next one
   * follows without a gap. One voice per answer: later sentences are pinned to the voice of the first; if that voice
   * fails partway, the remaining sentences are said in the fallback voice when it can have the next one ready within
   * FALLBACK_BUDGET_MS (it never switches back); otherwise "I've put the answer on screen." follows what was said, in
   * the answer's voice, and the rest is shown.
   */
  private async playPartsGapless(id: string, r: Reply, status: Status, open: (rate: number | null) => AudioOut, single?: { onStarted(): void }) {
    const gen = this.gen;
    // A single reply (speak()) has one part: its page listens for start, progress, end and cut, not parts.
    const emit = (e: SpeechEvent) => {
      if (!single) return this.d.emit(e);
      if (e.type === "part" || e.type === "part-end") return;
      if (e.type === "start" || e.type === "unavailable") single.onStarted();
      if (e.type === "part-progress") return this.d.emit({ kind: "voice:speech", id, type: "progress", t: e.t, d: e.d });
      if (e.type === "cut") return this.d.emit({ kind: "voice:speech", id, type: "cut", t: e.t, d: e.d });
      this.d.emit(e);
    };
    const hushed = () => gen !== this.gen;
    const report = new VoiceReport(id, "webaudio", null);
    const tasks = watchLongTasks("player");
    type Buffer = Parameters<AudioOut["play"]>[0];
    /** One sentence's audio as it arrives. */
    interface Feed {
      chunks: Uint8Array[];
      size: number;
      done: boolean;
      voice: string | null;
      wake: (() => void) | null;
      timing: ChunkTiming;
    }
    type Got = { kind: "feed"; feed: Feed } | { kind: "none" } | { kind: "failed" };
    let out: AudioOut | null = null;
    // The voice this answer is in: the one that said its first sentence.
    let pin: string | null = null;
    let known: () => void = () => {};
    const voiceKnown = new Promise<void>((resolve) => (known = resolve));
    const jobs = new Map<number, Promise<Got>>();
    const timeline = new Timeline();
    const sources: Array<{ stop(): void }> = [];
    const segments: Array<{ index: number; start: number; end: number; complete: boolean; line?: boolean; begun?: boolean; done?: boolean; lastProgress?: number }> = [];
    let anchor: { ms: number; t: number } | null = null;
    const toMs = (t: number) => (anchor ? anchor.ms + (t - anchor.t) * 1000 : null);
    let begun = false;
    let stopped = false;
    const over = () => hushed() || stopped;
    const stopAll = () => {
      stopped = true;
      for (const s of sources) s.stop();
      sources.length = 0;
    };
    this.gapless = { stop: stopAll };
    const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

    // Asks for one sentence (index -1: the on-screen line) and reads its audio as it comes. One retry before any audio.
    const openFeed = async (index: number, text: string, voice: string | null): Promise<Got> => {
      const timing = index >= 0 ? report.chunk(index) : new VoiceReport(id, "webaudio", null).chunk(0);
      timing.requestAt = this.d.now();
      const url = `${r.api}/voice/speak?text=${encodeURIComponent(text)}${voice ? `&voice=${encodeURIComponent(voice)}` : ""}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await this.d.fetch(url).catch(() => null);
        if (over()) return { kind: "none" };
        if (!res?.ok || !res.body) continue;
        const reader = res.body.getReader();
        const first = await reader.read().catch(() => null);
        if (!first || first.done || !first.value?.byteLength) continue;
        timing.firstByteAt = this.d.now();
        const v = res.headers.get("x-voice");
        timing.model = `${v ?? "?"}${res.headers.get("x-voice-cache") === "prerecorded" ? " (prerecorded)" : ""}${attempt ? " (retry)" : ""}`;
        timing.sampleRate = mp3SampleRate(first.value.subarray(0, 4096));
        const feed: Feed = { chunks: [first.value], size: first.value.byteLength, done: false, voice: v, wake: null, timing };
        if (index === 0) {
          pin = v;
          this.d.debug?.(`[glance] reply voice: ${v ?? "?"}`);
          known();
        }
        void (async () => {
          for (;;) {
            const next = await reader.read().catch(() => null);
            if (!next || next.done || over()) break;
            if (next.value?.byteLength) {
              feed.chunks.push(next.value);
              feed.size += next.value.byteLength;
              feed.wake?.();
            }
          }
          if (over()) void reader.cancel().catch(() => {});
          feed.done = true;
          timing.readyAt = this.d.now();
          feed.wake?.();
        })();
        return { kind: "feed", feed };
      }
      return { kind: "failed" };
    };

    const job = (index: number): Promise<Got> => {
      let p = jobs.get(index);
      if (!p) {
        p = (async (): Promise<Got> => {
          const text = await this.partText(r, index, gen);
          if (text === null || over()) return { kind: "none" };
          report.chunk(index).textAt = this.d.now();
          if (index > 0) await voiceKnown;
          if (over()) return { kind: "none" };
          const got = await openFeed(index, text, index === 0 ? null : pin);
          if (index === 0) known();
          return got;
        })();
        jobs.set(index, p);
      }
      return p;
    };

    // Which sentence is sounding now (0 before the first starts).
    const current = () => {
      const t = out?.currentTime ?? 0;
      let at = 0;
      for (const s of segments) if (!s.line && s.start <= t) at = s.index;
      return at;
    };

    // The events the page follows (its drawings keep time with the words), from the output clock.
    const tick = () => {
      if (!out || stopped) return;
      const t = out.currentTime;
      for (const s of segments) {
        if (s.line || s.done) continue;
        if (!s.begun && t >= s.start) {
          s.begun = true;
          if (!begun) {
            begun = true;
            emit({ kind: "voice:speech", id, type: "start" });
          }
          emit({ kind: "voice:speech", id, type: "part", index: s.index });
        }
        if (s.begun && s.complete && t >= s.end) {
          s.done = true;
          emit({ kind: "voice:speech", id, type: "part-end", index: s.index });
        } else if (s.begun && (s.lastProgress === undefined || t - s.lastProgress >= 0.25)) {
          s.lastProgress = t;
          emit({ kind: "voice:speech", id, type: "part-progress", index: s.index, t: Math.min(t, s.end) - s.start, d: s.complete ? s.end - s.start : null });
        }
      }
    };
    const ticker = setInterval(tick, 40);

    // Plays a feed's sentence slice by slice as it arrives, each slice where the last one ends. False: no sound came.
    const playFeed = async (index: number, feed: Feed, line = false): Promise<boolean> => {
      let taken = 0; // samples scheduled
      let decodedBytes = 0;
      let last: Buffer | null = null;
      let seg: (typeof segments)[number] | null = null;
      for (;;) {
        if (over()) return seg !== null;
        const done = feed.done;
        const bytes = new Uint8Array(feed.size);
        let at = 0;
        for (const c of feed.chunks) {
          bytes.set(c, at);
          at += c.byteLength;
        }
        const upToFrame = done ? bytes.length : (mp3FrameEnd(bytes) ?? bytes.length);
        if (upToFrame > decodedBytes) {
          if (!out) {
            // One output per answer, at the speech's own rate.
            out = open(feed.timing.sampleRate);
            report.contextRate = out.sampleRate;
          }
          const decoded = await out.decode(bytes.slice(0, upToFrame).buffer).catch(() => null);
          if (decoded) last = decoded;
          // Not decodable yet: wait for more; at the end, what did decode is all there is.
          if (decoded || done) decodedBytes = upToFrame;
        }
        if (over()) return seg !== null;
        const final = done && decodedBytes === upToFrame;
        if (last) {
          // The newest samples wait while more may come: the decoder can still change its last few.
          const upto = Math.max(taken, last.length - (final ? 0 : Math.round(TAIL_HOLD_S * last.sampleRate)));
          if (upto - taken >= (final ? 1 : Math.round(MIN_SLICE_S * last.sampleRate))) {
            const piece = taken === 0 && upto === last.length ? last : out!.slice(last, taken, upto);
            if (!anchor) anchor = { ms: this.d.now(), t: out!.currentTime };
            const placed = timeline.place(out!.currentTime, piece.duration);
            if (placed.late) {
              // The sound ran out before this was ready: inside a sentence it's a gap of its own.
              report.underruns++;
              if (seg) report.innerGaps.push(Math.round(placed.gap * 1000));
            }
            sources.push(out!.play(piece, placed.start, { in: taken === 0 ? FADE_S : 0, out: final ? FADE_S : 0 }));
            if (!seg) {
              seg = { index, start: placed.start, end: placed.end, complete: false, line };
              segments.push(seg);
              if (!line) {
                feed.timing.playStartAt = toMs(placed.start);
                if (feed.voice) report.voices.add(feed.voice);
              }
            }
            seg.end = placed.end;
            taken = upto;
          }
        }
        if (final) {
          if (seg) {
            seg.complete = true;
            if (!line) feed.timing.playEndAt = toMs(seg.end);
          }
          return seg !== null;
        }
        // Wait for more of it (or its end).
        if (!feed.done) {
          await Promise.race([new Promise<void>((res) => (feed.wake = res)), sleep(120)]);
          feed.wake = null;
        }
      }
    };

    // Resolves once everything scheduled has played (or it was stopped).
    const drain = async () => {
      while (out && !over() && timeline.end !== null && out.currentTime < timeline.end) await sleep(40);
      tick();
    };

    const finish = (type: "end" | "unavailable" | "cut", part = 0) => {
      clearInterval(ticker);
      known(); // nothing waits on a voice that won't come
      if (this.gapless?.stop === stopAll) this.gapless = null;
      stopAll();
      out?.close();
      report.longTasks = tasks.stop();
      report.outcome = type === "end" ? "ended" : type === "cut" ? "on-screen" : "unavailable";
      this.replies.delete(id);
      if (type === "unavailable") {
        this.d.errorTone();
        this.status = null;
        emit({ kind: "voice:speech", id, type, ...(status.resting?.speech ? { resting: true } : {}) });
      } else if (type === "cut") emit({ kind: "voice:speech", id, type, t: 0, d: null, part });
      else emit({ kind: "voice:speech", id, type });
      // The report follows the end: the page keeps listening a few seconds for it.
      emit({ kind: "voice:speech", id, type: "report", report: report.summary() });
    };

    for (let index = 0; ; index++) {
      // Ask no further than two sentences past the one playing.
      while (!hushed() && index > current() + PREFETCH) await sleep(40);
      if (hushed()) return finish("end");
      for (let j = index; j <= current() + PREFETCH; j++) void job(j);
      let got = await job(index);
      if (hushed()) return finish("end");
      if (got.kind === "failed" && index > 0) {
        // The answer's voice failed partway. The rest in the fallback voice, if it can be ready in time; never back.
        const fallback = (status.voices ?? []).find((v) => v !== pin) ?? null;
        const said = pin;
        if (fallback) {
          pin = fallback;
          for (const j of [...jobs.keys()]) if (j >= index) jobs.delete(j);
          for (let j = index; j <= index + PREFETCH; j++) void job(j);
          got = await Promise.race([job(index), sleep(FALLBACK_BUDGET_MS).then((): Got => ({ kind: "failed" }))]);
          if (hushed()) return finish("end");
        }
        if (got.kind === "failed") {
          // Not in time: what was said stays said; the on-screen line follows it, in the same voice; the rest is shown.
          pin = said;
          const line = await openFeed(-1, LINES.answerOnScreen, said);
          if (line.kind === "feed") await playFeed(-1, line.feed, true);
          await drain();
          return finish("cut", index);
        }
      }
      if (got.kind === "none") {
        if (index === 0) return finish("unavailable");
        await drain();
        return finish("end");
      }
      if (got.kind === "failed") return finish("unavailable"); // the first sentence: no voice at all
      const played = await playFeed(index, got.feed);
      if (hushed()) return finish("end");
      if (!played && index === 0) return finish("unavailable");
    }
  }

  /** Plays one part: its own start, progress and end events; a stall or an error after it started is a cut. */
  private playOne(id: string, el: HTMLAudioElement, index: number, setup: (fail: () => void) => Promise<boolean>, report?: VoiceReport): Promise<"ended" | "cut" | "unavailable"> {
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
      // An underrun: the audio ran out while more was expected (it had started, and it hasn't ended).
      el.onwaiting = () => {
        if (begun && !settled && report) report.underruns++;
      };
      el.onplaying = () => {
        if (begun) return;
        begun = true;
        lastMove = this.d.now();
        if (report) report.chunk(index).playStartAt = this.d.now();
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
        if (report && begun) report.chunk(index).playEndAt = this.d.now();
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
    this.gapless?.stop();
    this.gapless = null;
    if (!this.playing) return;
    const { el } = this.playing;
    this.playing = null;
    el.pause();
  }
}
