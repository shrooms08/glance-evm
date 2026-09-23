/**
 * Push-to-talk and spoken replies for every Glance surface (floating orb, docked side panel, settings), with one
 * interface. The work happens in the offscreen document (lib/voiceWorker.ts): it records, streams the audio to the
 * Glance API (Deepgram), asks what was meant (Claude, validated), and plays the reply (Fish Audio). Events come back
 * over runtime messaging: relayed by the background to content scripts, and straight to extension pages.
 */
import { browser } from "wxt/browser";

import { safely, send as sendSafe } from "./lifecycle";
import type { FallbackReason, SpeechEvent, VoiceCommandContext, VoiceEvent, VoiceIntent, VoiceRequest, VoiceTiming } from "./voiceMessages";
import type { VoiceCode } from "./voiceReasons";

export interface VoiceHandlers {
  onStart?(): void;
  /** The key was released: the audio is being transcribed (show thinking). */
  onReleased?(): void;
  /** Only from the browser fallback; the server path has no interim text. */
  onInterim?(text: string): void;
  onFinal(text: string): void;
  /** What the API understood, and the reply it is speaking. Absent in the browser fallback. */
  onIntent?(intent: VoiceIntent): void;
  /** The browser's own speech recognition is being used instead of the Glance API. */
  onFallback?(reason: FallbackReason): void;
  onTiming?(timing: VoiceTiming): void;
  /** The spoken reply actually started and stopped playing. */
  onReplyStart?(): void;
  onReplyEnd?(): void;
  onError(code: VoiceCode): void;
  onEnd?(): void;
}

export interface VoiceSession {
  stop(): void;
  abort(): void;
}

/** How long after a release we wait for everything (transcript, intent, the reply starting) before giving up. */
export const STOP_TIMEOUT_MS = 12_000;
/** How long we wait for recording to start (or fail) before giving up on it. */
export const START_TIMEOUT_MS = 6_000;
/** A hold longer than this is a stuck key, not speech: stop and send what was heard. */
export const MAX_LISTEN_MS = 60_000;

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();

export function startVoice(h: VoiceHandlers, opts: { context?: VoiceCommandContext; vault?: string } = {}): VoiceSession {
  const guard = guarded(h);
  return guard.attach(startRemote(guard.handlers, opts));
}

/**
 * Makes a session impossible to leave hanging, whatever happens: onEnd fires exactly once, and every way of ending
 * without words carries a reason. If recording never starts, a release is never answered, or a hold runs on forever,
 * the session is ended here with a code the panel can explain ("no-start", "stop-timeout").
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
  const live = <A extends unknown[]>(fn?: (...a: A) => void) => (...a: A) => {
    if (!ended) fn?.(...a);
  };
  const handlers: VoiceHandlers = {
    onStart: () => {
      started = true;
      if (!ended) h.onStart?.();
    },
    onReleased: live(h.onReleased),
    onInterim: live(h.onInterim),
    onFinal: (t) => !ended && !errored && h.onFinal(t),
    onIntent: live(h.onIntent),
    onFallback: live(h.onFallback),
    onTiming: live(h.onTiming),
    onReplyStart: h.onReplyStart,
    onReplyEnd: h.onReplyEnd,
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

function startRemote(h: VoiceHandlers, opts: { context?: VoiceCommandContext; vault?: string }): VoiceSession {
  const session = newId();
  let lastSeq = 0;
  let ended = false;

  const onMessage = (msg: VoiceEvent | SpeechEvent) => {
    // The reply to this session is spoken under its id: follow its playback even after the session has ended.
    if (msg?.kind === "voice:speech" && msg.id === session) {
      if (msg.type === "start") h.onReplyStart?.();
      else h.onReplyEnd?.();
      if (msg.type !== "start") safely(() => browser.runtime.onMessage.removeListener(onMessage), undefined);
      return undefined;
    }
    if (msg?.kind !== "voice:event" || msg.session !== session || msg.seq <= lastSeq) return undefined;
    lastSeq = msg.seq;
    switch (msg.type) {
      case "started":
        h.onStart?.();
        break;
      case "released":
        h.onReleased?.();
        break;
      case "interim":
        h.onInterim?.(msg.text);
        break;
      case "final":
        h.onFinal(msg.text);
        break;
      case "intent":
        h.onIntent?.(msg.intent);
        break;
      case "fallback":
        h.onFallback?.(msg.reason);
        break;
      case "timing":
        h.onTiming?.(msg.timing);
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
  let intentSeen = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    // Keep listening for the reply's playback events only if a reply is coming.
    if (!intentSeen) safely(() => browser.runtime.onMessage.removeListener(onMessage), undefined);
    h.onEnd?.();
  };
  const withIntent = h.onIntent;
  h = {
    ...h,
    onIntent: (i) => {
      intentSeen = true;
      withIntent?.(i);
    },
  };

  // Subscribe before starting, so no event can arrive unheard.
  safely(() => browser.runtime.onMessage.addListener(onMessage), undefined);
  const request: VoiceRequest = { kind: "voice:start", session, lang: navigator.language || "en-US", context: opts.context ?? {}, vault: opts.vault };
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

/**
 * Speaks a reply in Glance's voice (Fish Audio through the API; the browser's voice if the API can't). onStart and
 * onEnd come from the audio's real playback, so the speaking orb moves exactly while the voice is heard. Resolves when
 * it has finished (or when it's clear nothing will play). With `enabled` false, nothing is spoken.
 */
export function speak(text: string, enabled: boolean, h: { onStart?(): void; onEnd?(): void } = {}): Promise<void> {
  if (!enabled || !text.trim()) return Promise.resolve();
  const id = newId();
  return new Promise<void>((resolve) => {
    let started = false;
    const finish = () => {
      safely(() => browser.runtime.onMessage.removeListener(onMessage), undefined);
      clearTimeout(timer);
      if (started) h.onEnd?.();
      resolve();
    };
    const onMessage = (msg: SpeechEvent) => {
      if (msg?.kind !== "voice:speech" || msg.id !== id) return undefined;
      if (msg.type === "start") {
        started = true;
        h.onStart?.();
      } else finish();
      return undefined;
    };
    // Nothing should take this long; never leave the orb speaking.
    const timer = setTimeout(finish, 30_000);
    safely(() => browser.runtime.onMessage.addListener(onMessage), undefined);
    sendSafe({ kind: "voice:speak", id, text } satisfies VoiceRequest).then(
      (ok) => ok === false && finish(),
      () => finish(),
    );
  });
}

/** Stops any reply that is playing. */
export function hush() {
  void sendSafe({ kind: "voice:hush" } satisfies VoiceRequest).catch(() => {});
}
