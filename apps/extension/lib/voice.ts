/**
 * The speech engine, using the browser's own APIs only: SpeechRecognition for input and speechSynthesis for replies.
 *
 * listen() must run in an extension page (the offscreen document or the side panel), never in a website: sites can
 * block the microphone with Permissions-Policy, and the permission there would belong to the site, not to Glance.
 * Use lib/voiceClient.ts from UI code; it picks the right place.
 */
import type { VoiceCode } from "./voiceReasons";

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function ctor(): (new () => Recognition) | null {
  const w = globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface Listener {
  stop(): void;
  abort(): void;
}

export interface ListenHandlers {
  onStart?(): void;
  onInterim(text: string): void;
  onFinal(text: string): void;
  onError(code: VoiceCode): void;
  /** Always last, after onFinal or onError. */
  onEnd?(): void;
}

/**
 * Starts listening in this context. Returns null (after onError) if recognition is unavailable here.
 * It never ends silently: every way it can stop maps to onFinal (words, possibly none) or onError with a code:
 *   the browser's own codes (network, not-allowed, audio-capture, no-speech, aborted, ...), plus
 *   "ended-before-start"  the browser ended recognition before it ever started (typically: no speech service)
 *   "ended-early"         it started, then ended on its own with nothing heard and nobody asking it to stop
 */
export function listen(lang: string, h: ListenHandlers): Listener | null {
  const Ctor = ctor();
  if (!Ctor) {
    h.onError("no-recognition");
    h.onEnd?.();
    return null;
  }
  const r = new Ctor();
  r.lang = lang;
  r.interimResults = true;
  r.continuous = true;
  r.maxAlternatives = 1;
  let text = "";
  let failed = false;
  let started = false;
  let heard = false;
  /** Who ended it: us (the key was released, or the caller gave up), or the browser on its own. */
  let asked: "stop" | "abort" | null = null;
  r.onstart = () => {
    started = true;
    h.onStart?.();
  };
  r.onresult = (e) => {
    let out = "";
    for (let i = 0; i < e.results.length; i++) out += e.results[i]![0]!.transcript;
    text = out.trim();
    heard = heard || text.length > 0;
    h.onInterim(text);
  };
  r.onerror = (e) => {
    if (import.meta.env.DEV) console.info(`[glance] SpeechRecognition error "${e.error}"`, e);
    // Our own abort is not a failure; anything else, including an abort we didn't ask for, is.
    if (e.error === "aborted" && asked === "abort") return;
    failed = true;
    h.onError(e.error);
  };
  r.onend = () => {
    if (!failed) {
      if (!started && !asked) h.onError("ended-before-start");
      else if (started && !heard && !asked) h.onError("ended-early");
      else h.onFinal(text);
    }
    h.onEnd?.();
  };
  try {
    r.start();
  } catch {
    h.onError("offscreen-failed");
    h.onEnd?.();
    return null;
  }
  return {
    stop: () => {
      asked ??= "stop";
      r.stop();
    },
    abort: () => {
      asked = "abort";
      r.abort();
    },
  };
}

export interface SpeakHandlers {
  /** The voice has actually started: show the speaking orb from here. */
  onStart?(): void;
  /** The voice has finished (or failed): stop the speaking orb here. */
  onEnd?(): void;
}

/** Longest a reply may take before we stop waiting for Chrome's onend (it is occasionally never fired). */
const MAX_UTTERANCE_MS = 30_000;
/** If no voice has started by then, speech isn't going to happen (no voices, or synthesis blocked). */
const START_TIMEOUT_MS = 2_500;

/**
 * Speaks a reply. The orb's speaking state follows the utterance's own start and end events, not a timer: onStart
 * fires when the voice actually begins, onEnd when it stops. If speech is off or unavailable, neither fires and the
 * promise resolves at once, so callers never show "speaking" when nothing is being said.
 */
export function speak(text: string, enabled: boolean, h: SpeakHandlers = {}): Promise<void> {
  if (!enabled || !text || typeof speechSynthesis === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    let started = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(startTimer);
      clearTimeout(maxTimer);
      if (started) h.onEnd?.();
      resolve();
    };
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = navigator.language || "en-US";
    u.rate = 1.05;
    u.onstart = () => {
      if (finished) return;
      started = true;
      clearTimeout(startTimer);
      h.onStart?.();
    };
    u.onend = finish;
    u.onerror = finish;
    const startTimer = setTimeout(() => !started && finish(), START_TIMEOUT_MS);
    const maxTimer = setTimeout(finish, MAX_UTTERANCE_MS);
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}
