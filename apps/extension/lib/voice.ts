/**
 * Push-to-talk with the browser's own speech APIs: SpeechRecognition for input, speechSynthesis for replies.
 * No external voice service. Where recognition is unavailable (Brave disables it; some sites block the microphone),
 * callers fall back to the typed command box, and the error says why in plain words.
 */

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function ctor(): (new () => Recognition) | null {
  const w = globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceSupported(): boolean {
  return ctor() !== null;
}

export function voiceErrorMessage(error: string): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "I can't use the microphone here. This site or your browser blocked it. Type instead, or open the side panel.";
    case "network":
      return "Voice isn't available in this browser. Type your request instead.";
    case "no-speech":
      return "I didn't hear anything. Hold the key and speak, or type instead.";
    case "audio-capture":
      return "I can't find a microphone. Type your request instead.";
    default:
      return "Voice stopped unexpectedly. Type your request instead.";
  }
}

export interface Listener {
  stop(): void;
  abort(): void;
}

/** Starts listening. onInterim fires as words arrive; onFinal once with the full text (possibly empty). */
export function listen(handlers: {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string, code: string) => void;
}): Listener | null {
  const Ctor = ctor();
  if (!Ctor) return null;
  const r = new Ctor();
  r.lang = navigator.language || "en-US";
  r.interimResults = true;
  r.continuous = true;
  r.maxAlternatives = 1;
  let text = "";
  let failed = false;
  r.onresult = (e) => {
    let finals = "";
    let interim = "";
    for (let i = 0; i < e.results.length; i++) {
      const res = e.results[i]!;
      if (res.isFinal) finals += res[0]!.transcript;
      else interim += res[0]!.transcript;
    }
    text = `${finals}${interim}`.trim();
    handlers.onInterim(text);
  };
  r.onerror = (e) => {
    if (e.error === "aborted") return;
    failed = true;
    handlers.onError(voiceErrorMessage(e.error), e.error);
  };
  r.onend = () => {
    if (!failed) handlers.onFinal(text);
  };
  try {
    r.start();
  } catch {
    return null;
  }
  return { stop: () => r.stop(), abort: () => r.abort() };
}

/** Speaks a reply. Resolves when finished (or immediately if speech is unavailable or off). */
export function speak(text: string, enabled: boolean): Promise<void> {
  if (!enabled || typeof speechSynthesis === "undefined" || !text) return Promise.resolve();
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = navigator.language || "en-US";
    u.rate = 1.05;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
    // Some voices never fire onend; do not leave the orb speaking forever.
    setTimeout(resolve, Math.min(15_000, 1_500 + text.length * 70));
  });
}

export function stopSpeaking() {
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}
