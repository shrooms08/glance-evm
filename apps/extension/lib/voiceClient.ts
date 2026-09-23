/**
 * Push-to-talk for every Glance surface, with one interface for floating and docked modes.
 *
 * - In a web page (the floating orb), recognition runs in the extension's offscreen document, never in the page, so no
 *   website can block the microphone. Events come back over runtime messaging, relayed by the background.
 * - In the side panel (an extension page), recognition runs right there, under the same extension-owned permission.
 */
import { browser } from "wxt/browser";

import { safely, send as sendSafe } from "./lifecycle";
import { listen } from "./voice";
import { voiceBlocker } from "./voiceDiagnostics";
import type { VoiceEvent, VoiceRequest } from "./voiceMessages";
import type { VoiceCode } from "./voiceReasons";

export interface VoiceHandlers {
  onStart?(): void;
  onInterim(text: string): void;
  onFinal(text: string): void;
  onError(code: VoiceCode): void;
  onEnd?(): void;
}

export interface VoiceSession {
  stop(): void;
  abort(): void;
}

/** How long after a stop we wait for the recognizer's final result before giving up on it. */
export const STOP_TIMEOUT_MS = 5_000;

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();

/** True in the side panel, settings and other extension pages; false in a content script. */
export function inExtensionPage(): boolean {
  return location.protocol === "chrome-extension:";
}

/** `via: "offscreen"` forces the in-page path from an extension page (settings uses it to test that path). */
export function startVoice(h: VoiceHandlers, opts: { via?: "offscreen" } = {}): VoiceSession {
  return inExtensionPage() && opts.via !== "offscreen" ? startLocal(h) : startRemote(h);
}

function startLocal(h: VoiceHandlers): VoiceSession {
  let stopped: "stop" | "abort" | null = null;
  let listener: ReturnType<typeof listen> = null;
  void voiceBlocker().then((blocker) => {
    // Chrome's side panel can't show the permission prompt itself, so "not granted yet" points to settings too.
    if (blocker) {
      h.onError(blocker);
      h.onEnd?.();
      return;
    }
    if (stopped === "abort") return h.onEnd?.();
    listener = listen(navigator.language || "en-US", h);
    if (stopped === "stop") listener?.stop();
  });
  return {
    stop: () => (listener ? listener.stop() : (stopped = "stop")),
    abort: () => (listener ? listener.abort() : (stopped = "abort")),
  };
}

function startRemote(h: VoiceHandlers): VoiceSession {
  const session = newId();
  let lastSeq = 0;
  let ended = false;

  const onMessage = (msg: VoiceEvent) => {
    if (msg?.kind !== "voice:event" || msg.session !== session || msg.seq <= lastSeq) return undefined;
    lastSeq = msg.seq;
    switch (msg.type) {
      case "started":
        h.onStart?.();
        break;
      case "interim":
        h.onInterim(msg.text);
        break;
      case "final":
        h.onFinal(msg.text);
        break;
      case "error":
        h.onError(msg.code);
        break;
      case "end":
        finish();
        break;
    }
    return undefined;
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    safely(() => browser.runtime.onMessage.removeListener(onMessage), undefined);
    h.onEnd?.();
  };

  // Subscribe before starting, so no event can arrive unheard.
  safely(() => browser.runtime.onMessage.addListener(onMessage), undefined);
  const request: VoiceRequest = { kind: "voice:start", session, lang: navigator.language || "en-US" };
  sendSafe(request).then(
    (ok: unknown) => {
      if (ok === false) {
        h.onError("offscreen-failed");
        finish();
      }
    },
    () => {
      h.onError("offscreen-failed");
      finish();
    },
  );

  const send = (kind: "voice:stop" | "voice:abort") => void sendSafe({ kind, session } satisfies VoiceRequest).catch(() => {});
  return {
    stop: () => {
      send("voice:stop");
      // If the speech service never answers the stop (it can hang when unreachable), don't leave the orb listening.
      setTimeout(() => {
        if (ended) return;
        send("voice:abort");
        h.onError("network");
        finish();
      }, STOP_TIMEOUT_MS);
    },
    abort: () => {
      send("voice:abort");
      finish();
    },
  };
}
