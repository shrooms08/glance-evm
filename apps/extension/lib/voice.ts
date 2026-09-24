/**
 * The browser's speech recognition, the fallback for input only (when the Glance API can't transcribe). Glance never
 * speaks with the browser's voice: every reply is Glance's own voice from the API (lib/voiceWorker.ts).
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
