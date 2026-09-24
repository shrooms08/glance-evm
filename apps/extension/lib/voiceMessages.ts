/**
 * The voice relay. Audio is never recorded in a web page (a site's Permissions-Policy can block the microphone there,
 * and the permission would be the site's). Glance's offscreen document records it, streams it to the Glance API
 * (Deepgram transcribes), asks the API what was meant (/voice/command), and plays the spoken reply (Deepgram Aura by default). The
 * background routes each session's events back to the tab that asked; extension pages receive them directly.
 */
import type { VoiceCode } from "./voiceReasons";

/** What the API understood. A buy only names the card to open: nothing trades without the confirm tap. */
export interface VoiceIntent {
  intent: "buy" | "sell" | "price" | "spend-so-far" | "explain" | "portfolio" | "why" | "chart" | "ask" | "unknown";
  symbol: string | null;
  amount: string | null;
  /** The one-sentence spoken reply (already being spoken by the offscreen document). */
  reply: string;
}

/** Milliseconds from the key's release to each step. */
export interface VoiceTiming {
  transcript: number;
  intent?: number;
  /** Audio actually started playing. */
  speaking?: number;
  /** Where the transcript came from. */
  via: "stream" | "upload" | "browser";
}

/** Why the browser's own speech recognition was used instead of the Glance API. */
export type FallbackReason = "api-unreachable" | "no-provider";

/** `seq` increases per session, so a client that receives an event twice (broadcast and relay) can ignore repeats. */
export type VoiceEvent = { kind: "voice:event"; session: string; seq: number } & (
  | { type: "started" }
  /** The key was released: the audio is on its way to be transcribed. */
  | { type: "released" }
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "intent"; intent: VoiceIntent }
  | { type: "fallback"; reason: FallbackReason }
  | { type: "timing"; timing: VoiceTiming }
  | { type: "error"; code: VoiceCode }
  | { type: "end" }
);

/** Playback of a spoken reply, from the audio element's own events. */
export type SpeechEvent =
  | { kind: "voice:speech"; id: string; type: "start" | "end" | "unavailable" }
  /** While it plays (about 4 a second): where playback is, and the audio's length once the player knows it. */
  | { kind: "voice:speech"; id: string; type: "progress"; t: number; d: number | null };

/** What the page (or side panel) knows that helps the API understand a command. */
export interface VoiceCommandContext {
  host?: string;
  companies?: Array<{ symbol: string; mentions: number }>;
  lastGuard?: { code: string; message: string } | null;
  lastReply?: string | null;
  openCard?: string | null;
}

export type VoiceRequest =
  | { kind: "voice:start"; session: string; lang: string; context: VoiceCommandContext; vault?: string }
  | { kind: "voice:stop"; session: string }
  | { kind: "voice:abort"; session: string }
  | { kind: "voice:speak"; id: string; text: string }
  | { kind: "voice:hush" }
  /** The panel opened: have the API warm its provider connections for a command that may be coming. */
  | { kind: "voice:warm" }
  /** From the offscreen document: getUserMedia failed with this error name. The background answers with the code. */
  | { kind: "voice:mic-failed"; name: string }
  /** From the offscreen document: the microphone opened. */
  | { kind: "voice:mic-worked" };

/** Background -> offscreen document. The background adds the API's address, which the offscreen document can't read. */
export type OffscreenRequest =
  | { kind: "offscreen:start"; session: string; lang: string; api: string; context: VoiceCommandContext; vault?: string }
  | { kind: "offscreen:stop"; session: string }
  | { kind: "offscreen:abort"; session: string }
  | { kind: "offscreen:speak"; id: string; text: string; api: string }
  | { kind: "offscreen:hush" }
  | { kind: "offscreen:warm"; api: string };
