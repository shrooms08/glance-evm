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
/** How long we wait for recognition to start (or fail) before giving up on it. */
export const START_TIMEOUT_MS = 6_000;
/** A hold longer than this is a stuck key, not speech: stop and send what was heard. */
export const MAX_LISTEN_MS = 60_000;

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();

/** True in the side panel, settings and other extension pages; false in a content script. */
export function inExtensionPage(): boolean {
  return location.protocol === "chrome-extension:";
}

/** `via: "offscreen"` forces the in-page path from an extension page (settings uses it to test that path). */
export function startVoice(h: VoiceHandlers, opts: { via?: "offscreen" } = {}): VoiceSession {
  const guard = guarded(h);
  const inner = inExtensionPage() && opts.via !== "offscreen" ? startLocal(guard.handlers) : startRemote(guard.handlers);
  return guard.attach(inner);
}

/**
 * Makes a session impossible to leave hanging, whatever the browser does: onEnd fires exactly once, and every way of
 * ending without words carries a reason. If recognition never starts, never answers a stop, or runs on forever, the
 * session is ended here with a code the panel can explain ("no-start", "stop-timeout").
 */
function guarded(h: VoiceHandlers) {
  let ended = false;
  let errored = false;
  let started = false;
  let inner: VoiceSession | null = null;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const end = () => {
    if (ended) return;
    ended = true;
    timers.forEach(clearTimeout);
    h.onEnd?.();
  };
  const fail = (code: VoiceCode) => {
    if (ended || errored) return;
    errored = true;
    h.onError(code);
  };
  const giveUp = (code: VoiceCode) => {
    if (ended) return;
    fail(code); // the reason first: aborting the inner session ends it
    inner?.abort();
    end();
  };
  const handlers: VoiceHandlers = {
    onStart: () => {
      started = true;
      if (!ended) h.onStart?.();
    },
    onInterim: (t) => !ended && h.onInterim(t),
    onFinal: (t) => !ended && !errored && h.onFinal(t),
    onError: fail,
    onEnd: end,
  };
  timers.push(setTimeout(() => !started && giveUp("no-start"), START_TIMEOUT_MS));
  timers.push(setTimeout(() => inner?.stop(), MAX_LISTEN_MS));
  return {
    handlers,
    attach(session: VoiceSession): VoiceSession {
      inner = session;
      return {
        stop: () => {
          if (ended) return;
          session.stop();
          timers.push(setTimeout(() => giveUp("stop-timeout"), STOP_TIMEOUT_MS));
        },
        abort: () => {
          if (ended) return;
          session.abort();
          end();
        },
      };
    },
  };
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
    stop: () => send("voice:stop"),
    abort: () => {
      send("voice:abort");
      finish();
    },
  };
}
