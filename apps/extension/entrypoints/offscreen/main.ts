/**
 * Glance's offscreen document: the voice worker (lib/voiceWorker.ts) for every surface.
 *
 * It lives at chrome-extension://<our id>, so the microphone permission is Glance's own (granted once from settings)
 * and no website's Permissions-Policy can block it. The background creates it on demand (reasons USER_MEDIA and
 * AUDIO_PLAYBACK), passes it the Glance API's address with each request (an offscreen document can't read storage),
 * and relays its events to the tab that asked.
 */
import { browser } from "wxt/browser";

import { listen, speak as speakWithBrowser } from "../../lib/voice";
import { micBlocker } from "../../lib/voiceDiagnostics";
import type { OffscreenRequest, SpeechEvent, VoiceEvent } from "../../lib/voiceMessages";
import { VoiceWorker } from "../../lib/voiceWorker";

const worker = new VoiceWorker({
  fetch: (...args) => fetch(...args),
  WebSocket,
  getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }),
  MediaRecorder,
  createAudio: () => new Audio(),
  micBlocker,
  listen,
  speakLocally: async (text, onStart) => {
    let started = false;
    await speakWithBrowser(text, true, {
      onStart: () => {
        started = true;
        onStart();
      },
    });
    return started;
  },
  emit: (e: VoiceEvent | SpeechEvent) => void browser.runtime.sendMessage(e).catch(() => {}),
  now: () => performance.now(),
});

browser.runtime.onMessage.addListener((msg: OffscreenRequest) => {
  switch (msg.kind) {
    case "offscreen:start":
      void worker.start(msg.session, msg.lang, msg.api, msg.context, msg.vault);
      break;
    case "offscreen:stop":
      void worker.stop(msg.session);
      break;
    case "offscreen:abort":
      worker.abort(msg.session);
      break;
    case "offscreen:speak":
      void worker.speak(msg.id, msg.text, msg.api);
      break;
    case "offscreen:hush":
      worker.hush();
      break;
  }
  return undefined;
});
