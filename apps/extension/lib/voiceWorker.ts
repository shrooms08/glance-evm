/**
 * The voice worker, run by Glance's offscreen document for every surface (the floating orb, the docked side panel,
 * the settings test). It never runs in a web page.
 *
 *   key down   check the microphone; open a WebSocket to the Glance API's /voice/stream; start MediaRecorder and send
 *              each 100ms chunk as it is recorded (so almost nothing is left to upload on release)
 *   key up     stop the recorder, send {"type":"stop"}, and get the transcript (Deepgram, server side). If the stream
 *              couldn't open, POST the recording to /voice/transcribe instead
 *   then       POST the transcript to /voice/command (intent + one-sentence reply), and play the reply from
 *              GET /voice/speak (Fish Audio), which starts playing while it downloads
 *
 * Fallback: only if the Glance API can't be reached, or has no transcription provider, the browser's own speech
 * recognition is used instead, and a "fallback" event says so, so the panel can say it plainly. Replies fall back to
 * the browser's speech synthesis the same way. Every browser dependency is injected, so this is unit tested.
 */
import type { Listener, ListenHandlers } from "./voice";
import type { FallbackReason, SpeechEvent, VoiceCommandContext, VoiceEvent, VoiceIntent, VoiceTiming } from "./voiceMessages";
import type { VoiceCode } from "./voiceReasons";

type EventBody = VoiceEvent extends infer E ? (E extends VoiceEvent ? Omit<E, "kind" | "session" | "seq"> : never) : never;

export interface WorkerDeps {
  fetch: typeof fetch;
  WebSocket: new (url: string) => WebSocket;
  getUserMedia(): Promise<MediaStream>;
  MediaRecorder: new (stream: MediaStream, opts?: MediaRecorderOptions) => MediaRecorder;
  /** Creates the element a reply plays in. */
  createAudio(): HTMLAudioElement;
  micBlocker(): Promise<VoiceCode | null>;
  /** The browser's speech recognition, for the fallback only. */
  listen(lang: string, h: ListenHandlers): Listener | null;
  /** The browser's speech synthesis, for the fallback only. Resolves when done; onStart when audible. */
  speakLocally(text: string, onStart: () => void): Promise<boolean>;
  emit(e: VoiceEvent | SpeechEvent): void;
  now(): number;
}

/** How long the API has to answer /voice/status before we treat it as unreachable and fall back. */
export const STATUS_TIMEOUT_MS = 800;
/** How long the stream may take to open before the recording is uploaded whole instead. */
export const STREAM_OPEN_GRACE_MS = 1_500;
const TRANSCRIPT_TIMEOUT_MS = 6_000;
const STATUS_TTL_MS = 30_000;

interface Status {
  reachable: boolean;
  transcription: boolean;
  speech: boolean;
  stream: boolean;
}

interface Session {
  id: string;
  seq: number;
  api: string;
  context: VoiceCommandContext;
  vault?: string;
  lang: string;
  mode: "server" | "browser";
  pending: "stop" | "abort" | null;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  chunks: Blob[];
  mime: string;
  ws?: WebSocket;
  wsOpen?: Promise<boolean>;
  transcript?: Promise<string | null>;
  listener?: Listener | null;
  released: number;
  ended: boolean;
}

const httpToWs = (api: string) => api.replace(/^http/, "ws");

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
      const body = (await res.json()) as { available?: { transcription?: boolean; speech?: boolean; stream?: boolean } };
      value = { reachable: res.ok, transcription: Boolean(body.available?.transcription), speech: Boolean(body.available?.speech), stream: Boolean(body.available?.stream) };
    } catch {
      value = { reachable: false, transcription: false, speech: false, stream: false };
    }
    // Don't remember an outage for long: the API may just be starting.
    this.status = { at: value.reachable ? this.d.now() : this.d.now() - STATUS_TTL_MS + 3_000, api, value };
    return value;
  }

  async start(id: string, lang: string, api: string, context: VoiceCommandContext, vault?: string) {
    this.hush();
    const s: Session = { id, seq: 0, api, context, vault, lang, mode: "server", pending: null, chunks: [], mime: "audio/webm", released: 0, ended: false };
    this.sessions.set(id, s);

    const [blocker, status] = await Promise.all([this.d.micBlocker(), this.apiStatus(api)]);
    if (blocker) {
      this.emit(s, { type: "error", code: blocker });
      return this.emit(s, { type: "end" });
    }
    if (s.pending === "abort") return this.emit(s, { type: "end" });

    if (!status.reachable || !status.transcription) {
      return this.startBrowser(s, status.reachable ? "no-provider" : "api-unreachable");
    }
    try {
      s.stream = await this.d.getUserMedia();
    } catch (err) {
      const name = (err as DOMException).name;
      this.emit(s, { type: "error", code: name === "NotAllowedError" ? "mic-denied" : name === "NotFoundError" ? "no-mic" : "audio-capture" });
      return this.emit(s, { type: "end" });
    }

    // The stream to the API opens alongside the recorder; chunks recorded before it opens are sent once it does.
    if (status.stream) {
      const q = s.vault ? `?vault=${encodeURIComponent(s.vault)}` : "";
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
            const msg = JSON.parse(String(m.data)) as { type?: string; text?: string };
            if (msg.type === "transcript") resolve(msg.text ?? "");
            else if (msg.type === "error") resolve(null);
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

    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((m) => (this.d.MediaRecorder as unknown as { isTypeSupported?(m: string): boolean }).isTypeSupported?.(m) ?? m === "audio/webm");
    const recorder = new this.d.MediaRecorder(s.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined);
    s.recorder = recorder;
    s.mime = recorder.mimeType || mime || "audio/webm";
    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      s.chunks.push(e.data);
      void this.forward(s, e.data);
    };
    recorder.onstart = () => {
      this.emit(s, { type: "started" });
      if (s.pending === "stop") void this.stop(id);
      if (s.pending === "abort") this.abort(id);
    };
    recorder.start(100);
  }

  /** Sends a chunk down the stream, in order, once it is open. */
  private sendQueue = Promise.resolve();
  private forward(s: Session, chunk: Blob) {
    if (!s.ws || !s.wsOpen) return;
    const ws = s.ws;
    this.sendQueue = this.sendQueue.then(async () => {
      if (!(await s.wsOpen)) return;
      if (ws.readyState === 1) ws.send(await chunk.arrayBuffer());
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
    if (!s.recorder || s.recorder.state === "inactive") {
      s.pending = "stop"; // released before the recorder started: stop as soon as it does
      return;
    }
    s.released = this.d.now();
    this.emit(s, { type: "released" });
    const recorder = s.recorder;
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    s.stream?.getTracks().forEach((t) => t.stop());
    await this.sendQueue;

    let text: string | null = null;
    let via: VoiceTiming["via"] = "stream";
    if (s.ws && (await Promise.race([s.wsOpen!, new Promise<boolean>((r) => setTimeout(() => r(false), STREAM_OPEN_GRACE_MS))]))) {
      s.ws.send(JSON.stringify({ type: "stop" }));
      text = await Promise.race([s.transcript!, new Promise<null>((r) => setTimeout(() => r(null), TRANSCRIPT_TIMEOUT_MS))]);
    }
    if (text === null) {
      via = "upload";
      s.ws?.close();
      try {
        const res = await this.d.fetch(`${s.api}/voice/transcribe`, {
          method: "POST",
          headers: { "content-type": s.mime },
          body: new Blob(s.chunks, { type: s.mime }),
          signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT_MS),
        });
        if (res.ok) text = ((await res.json()) as { text?: string }).text ?? "";
      } catch {
        text = null;
      }
    }
    const timing: VoiceTiming = { transcript: this.d.now() - s.released, via };
    if (text === null) {
      this.emit(s, { type: "error", code: "transcription-failed" });
      return this.emit(s, { type: "end" });
    }
    this.emit(s, { type: "final", text });
    if (!text.trim()) {
      this.emit(s, { type: "timing", timing });
      return this.emit(s, { type: "end" });
    }

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
    this.emit(s, { type: "intent", intent: { intent: intent.intent, symbol: intent.symbol, amount: intent.amount, reply: intent.reply } });
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
    if (s.recorder && s.recorder.state !== "inactive") s.recorder.stop();
    s.stream?.getTracks().forEach((t) => t.stop());
    s.ws?.close();
    if (s.recorder || s.listener) this.emit(s, { type: "end" });
  }

  /**
   * Speaks `text`: the API's voice (Fish Audio) when it has one, else the browser's. The "start" event fires when the
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

  private async play(id: string, text: string, api: string, onStarted?: () => void) {
    let started = false;
    const markStarted = () => {
      if (started) return;
      started = true;
      onStarted?.();
    };
    const status = await this.apiStatus(api);
    if (status.speech) {
      const el = this.d.createAudio();
      this.playing = { el, id };
      const played = await new Promise<boolean>((resolve) => {
        let begun = false;
        el.onplaying = () => {
          if (begun) return;
          begun = true;
          markStarted();
          this.d.emit({ kind: "voice:speech", id, type: "start" });
        };
        const done = (ok: boolean) => () => {
          if (this.playing?.el === el) this.playing = null;
          if (begun) this.d.emit({ kind: "voice:speech", id, type: "end" });
          resolve(ok || begun);
        };
        el.onended = done(true);
        el.onpause = done(true);
        el.onerror = done(false);
        el.src = `${api}/voice/speak?text=${encodeURIComponent(text)}`;
        void el.play().catch(() => resolve(false));
      });
      if (played) return;
    }
    // The browser's own voice, as a last resort.
    const spoke = await this.d.speakLocally(text, () => {
      markStarted();
      this.d.emit({ kind: "voice:speech", id, type: "start" });
    });
    if (spoke) this.d.emit({ kind: "voice:speech", id, type: "end" });
    else {
      markStarted();
      this.d.emit({ kind: "voice:speech", id, type: "unavailable" });
    }
  }

  /** Stops any reply that is playing, and drops any queued (a new command, or the user talking over it). */
  hush() {
    this.gen++;
    if (!this.playing) return;
    const { el } = this.playing;
    this.playing = null;
    el.pause();
  }
}
