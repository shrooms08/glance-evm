/**
 * Fake voice providers, for exercising the whole voice path (the extension's recording, the stream, the command, the
 * reply's playback) without Deepgram or Fish keys: VOICE_PROVIDERS=fake. Refused in production. The transcript is
 * fixed (VOICE_FAKE_TRANSCRIPT) and the reply is a pre-recorded clip, so the numbers measured with it are Glance's
 * own overhead, not the providers'.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { LiveTranscription, Speaker, Transcriber, Transcript } from "./providers.js";

const clip = () => new Uint8Array(readFileSync(resolve(import.meta.dirname, "../../test/fixtures/fake-reply.mp3")));

export function fakeTranscriber(text: string, delayMs: number): Transcriber {
  const answer = (): Promise<Transcript> => new Promise((r) => setTimeout(() => r({ text, confidence: 1 }), delayMs));
  return {
    name: "fake",
    model: "fixed transcript",
    transcribe: () => answer(),
    stream(): LiveTranscription {
      let bytes = 0;
      return {
        send: (chunk) => void (bytes += chunk.byteLength),
        finish: () => (bytes > 0 ? answer() : Promise.resolve({ text: "", confidence: 0 })),
        abort: () => {},
      };
    },
  };
}

export function fakeSpeaker(delayMs: number): Speaker {
  return {
    name: "fake",
    model: "pre-recorded clip",
    voice: "fake",
    speak: () => new Promise((r) => setTimeout(() => r({ audio: clip(), mime: "audio/mpeg" }), delayMs)),
  };
}
