/**
 * Glance's offscreen document: the voice worker (lib/voiceWorker.ts) for every surface.
 *
 * It lives at chrome-extension://<our id>, so the microphone permission is Glance's own (granted once from settings)
 * and no website's Permissions-Policy can block it. The background creates it once per browser session and keeps it
 * open (reason USER_MEDIA only, see lib/offscreenDoc.ts), so a grant the browser tied to the page being open isn't
 * dropped between uses. It passes it the Glance API's address with each request (an offscreen document can't read
 * storage), and relays its events to the tab that asked.
 */
import { browser } from "wxt/browser";

import { listen } from "../../lib/voice";
import type { OffscreenRequest, SpeechEvent, VoiceEvent, VoiceRequest } from "../../lib/voiceMessages";
import type { VoiceCode } from "../../lib/voiceReasons";
import { toPcm16, VoiceWorker } from "../../lib/voiceWorker";

/** 40ms of audio per message to the API: small enough that little is left to send on release. */
const SLICE_SAMPLES = 640;

/**
 * The audio graph (a 16kHz AudioContext with the capture worklet loaded), made once and kept, suspended between turns:
 * a turn only connects the microphone to it. Made ahead of time when the panel opens (no microphone involved).
 */
let graph: Promise<AudioContext> | null = null;
function audioGraph(): Promise<AudioContext> {
  graph ??= (async () => {
    const ctx = new AudioContext({ sampleRate: 16_000 });
    await ctx.audioWorklet.addModule(browser.runtime.getURL("/pcm-worklet.js"));
    await ctx.suspend();
    return ctx;
  })().catch((err: unknown) => {
    graph = null;
    throw err;
  });
  return graph;
}

/** The microphone as 16kHz 16-bit PCM, via an AudioWorklet (public/pcm-worklet.js). */
async function capturePcm(stream: MediaStream, onChunk: (pcm: Uint8Array) => void) {
  const ctx = await audioGraph();
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "glance-pcm");
  let buffer = new Float32Array(SLICE_SAMPLES);
  let filled = 0;
  const flush = () => {
    if (filled === 0) return;
    onChunk(toPcm16(buffer.subarray(0, filled)));
    buffer = new Float32Array(SLICE_SAMPLES);
    filled = 0;
  };
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    let block = e.data;
    while (block.length) {
      const take = Math.min(block.length, SLICE_SAMPLES - filled);
      buffer.set(block.subarray(0, take), filled);
      filled += take;
      block = block.subarray(take);
      if (filled === SLICE_SAMPLES) flush();
    }
  };
  // A worklet only runs while the graph pulls it: route it into a muted gain so nothing is heard.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node).connect(mute).connect(ctx.destination);
  await ctx.resume();
  return {
    async stop() {
      // Let the worklet hand over its last block (one render quantum is 8ms at 16kHz), then send the remainder.
      await new Promise((r) => setTimeout(r, 20));
      source.disconnect();
      node.disconnect();
      mute.disconnect();
      node.port.onmessage = null;
      flush();
      await ctx.suspend();
    },
  };
}

/**
 * Plays an MP3 as it downloads: each chunk goes into a MediaSource buffer the moment it arrives, so the voice starts
 * about when the provider's first bytes do (an <audio> element given the URL waits for the whole file). The element's
 * own playing/ended events still drive the speaking orb.
 */
async function streamInto(el: HTMLAudioElement, url: string, onVoice?: (voice: string | null) => void) {
  if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported("audio/mpeg")) {
    el.src = url;
    return;
  }
  const ms = new MediaSource();
  el.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
  const sb = ms.addSourceBuffer("audio/mpeg");
  const res = await fetch(url);
  onVoice?.(res.headers.get("x-voice"));
  if (!res.ok || !res.body) {
    ms.endOfStream("network");
    throw new Error(`speech answered ${res.status}`);
  }
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await new Promise<void>((resolve, reject) => {
      sb.addEventListener("updateend", () => resolve(), { once: true });
      sb.addEventListener("error", () => reject(new Error("audio buffer error")), { once: true });
      sb.appendBuffer(value);
    });
  }
  if (ms.readyState === "open") ms.endOfStream();
}

/**
 * "No voice right now": a soft, short two-note tone (Glance never speaks in another voice instead). Web Audio, no
 * file; quiet, and silent if audio can't play.
 */
function errorTone() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    for (const [i, f] of [660, 494].entries()) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      o.connect(gain);
      o.start(now + i * 0.12);
      o.stop(now + 0.12 + i * 0.12 + 0.1);
    }
    setTimeout(() => void ctx.close().catch(() => {}), 600);
  } catch {
    // sound is a courtesy, never an error
  }
}

const worker = new VoiceWorker({
  fetch: (...args) => fetch(...args),
  WebSocket,
  getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }),
  capturePcm,
  createAudio: () => new Audio(),
  streamInto,
  // This document has no chrome.storage: the background remembers what worked and decides what to show.
  micFailed: async (name) => ((await browser.runtime.sendMessage({ kind: "voice:mic-failed", name } satisfies VoiceRequest)) as VoiceCode | undefined) ?? "mic-denied",
  micWorked: () => void browser.runtime.sendMessage({ kind: "voice:mic-worked" } satisfies VoiceRequest).catch(() => {}),
  listen,
  errorTone,
  objectUrl: (blob) => URL.createObjectURL(blob),
  debug: (line) => {
    if (import.meta.env.DEV) console.debug(line);
  },
  emit: (e: VoiceEvent | SpeechEvent) => void browser.runtime.sendMessage(e).catch(() => {}),
  now: () => performance.now(),
});

browser.runtime.onMessage.addListener((msg: OffscreenRequest) => {
  switch (msg.kind) {
    case "offscreen:start":
      void worker.start(msg.session, msg.lang, msg.api, msg.context, msg.vault, msg.listen);
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
    case "offscreen:speak-part":
      worker.speakPart(msg.id, msg.index, msg.text, msg.api);
      break;
    case "offscreen:speak-end":
      worker.speakEnd(msg.id, msg.total);
      break;
    case "offscreen:hush":
      worker.hush();
      break;
    case "offscreen:warm":
      worker.warm(msg.api, msg.panel ? "panel" : undefined);
      void audioGraph().catch(() => {});
      break;
  }
  return undefined;
});
