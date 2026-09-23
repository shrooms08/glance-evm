/**
 * Glance's offscreen document: the one place speech recognition runs for in-page use.
 *
 * It lives at chrome-extension://<our id>, so the microphone permission is Glance's own (granted once from settings)
 * and no website's Permissions-Policy can block it. The background creates this document on demand (reason
 * USER_MEDIA) and relays each session's events to the tab that asked. It has no UI and cannot show a permission
 * prompt, so it checks what is missing first and reports the exact reason.
 */
import { browser } from "wxt/browser";

import { listen, type Listener } from "../../lib/voice";
import { voiceBlocker } from "../../lib/voiceDiagnostics";
import type { OffscreenRequest, VoiceEvent } from "../../lib/voiceMessages";

const sessions = new Map<string, Listener>();
/** A stop or abort that arrived while the session was still starting (checking the microphone): applied once it has. */
const pending = new Map<string, "stop" | "abort">();
const seqs = new Map<string, number>();

type EventBody = VoiceEvent extends infer E ? (E extends VoiceEvent ? Omit<E, "kind" | "session" | "seq"> : never) : never;

function emit(session: string, body: EventBody) {
  const seq = (seqs.get(session) ?? 0) + 1;
  seqs.set(session, seq);
  void browser.runtime.sendMessage({ kind: "voice:event", session, seq, ...body } as VoiceEvent).catch(() => {});
}

async function start(session: string, lang: string) {
  const blocker = await voiceBlocker();
  if (blocker) {
    pending.delete(session);
    emit(session, { type: "error", code: blocker });
    emit(session, { type: "end" });
    return;
  }
  if (pending.get(session) === "abort") {
    pending.delete(session);
    emit(session, { type: "end" });
    return;
  }
  const l = listen(lang, {
    onStart: () => emit(session, { type: "started" }),
    onInterim: (text) => emit(session, { type: "interim", text }),
    onFinal: (text) => emit(session, { type: "final", text }),
    onError: (code) => emit(session, { type: "error", code }),
    onEnd: () => {
      sessions.delete(session);
      emit(session, { type: "end" });
      seqs.delete(session);
    },
  });
  if (l) sessions.set(session, l);
  // Released before recognition started: stop as soon as it has, and report what (little) was heard.
  if (l && pending.get(session) === "stop") l.stop();
  pending.delete(session);
}

browser.runtime.onMessage.addListener((msg: OffscreenRequest) => {
  if (msg.kind === "offscreen:start") void start(msg.session, msg.lang);
  else if (msg.kind === "offscreen:stop") {
    const l = sessions.get(msg.session);
    if (l) l.stop();
    else pending.set(msg.session, "stop");
  } else if (msg.kind === "offscreen:abort") {
    const l = sessions.get(msg.session);
    if (l) l.abort();
    else pending.set(msg.session, "abort");
  }
  return undefined;
});
