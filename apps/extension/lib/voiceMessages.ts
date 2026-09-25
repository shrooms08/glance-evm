/**
 * The voice relay. Audio is never recorded in a web page (a site's Permissions-Policy can block the microphone there,
 * and the permission would be the site's). Glance's offscreen document records it, streams it to the Glance API
 * (Deepgram transcribes), asks the API what was meant (/voice/command), and plays the spoken reply (Deepgram Aura by default). The
 * background routes each session's events back to the tab that asked; extension pages receive them directly.
 */
import type { VoiceCode } from "./voiceReasons";

/** What the API understood. A buy only names the card to open: nothing trades without the confirm tap. */
export interface VoiceIntent {
  intent: "buy" | "sell" | "price" | "spend-so-far" | "explain" | "portfolio" | "why" | "chart" | "ask" | "basket-buy" | "basket-make" | "baskets" | "compare" | "unknown";
  symbol: string | null;
  amount: string | null;
  /** "compare": the stocks and the range. */
  symbols?: string[];
  range?: "1D" | "1W" | "1M";
  /** The one-sentence spoken reply (already being spoken by the offscreen document). */
  reply: string;
}

/**
 * How to listen: conversation mode (one tap starts; the speaker's end of turn sends it, no release) and the session's
 * own words for speech recognition (the user's basket names).
 */
export interface ListenOptions {
  conversation?: boolean;
  keyterms?: string[];
  /** Said when a turn ends with nothing heard (the key's own name in it; pre-recorded for ⌥V). */
  notHeard?: string;
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
  | { kind: "voice:speech"; id: string; type: "start" | "end" }
  /** No voice for this reply; `resting`: today's speech cap is used up ("Voice is resting for today."). */
  | { kind: "voice:speech"; id: string; type: "unavailable"; resting?: boolean }
  /** While it plays (about 4 a second): where playback is, and the audio's length once the player knows it. */
  | { kind: "voice:speech"; id: string; type: "progress"; t: number; d: number | null }
  /** The audio stopped mid-reply (a stall or an error), at `t` seconds: the rest is shown, never said in another voice. */
  | { kind: "voice:speech"; id: string; type: "cut"; t: number; d: number | null; part?: number }
  /** A reply spoken in parts (one per sentence): part `index` started, or ended. */
  | { kind: "voice:speech"; id: string; type: "part" | "part-end"; index: number }
  /** Progress within part `index` of a reply spoken in parts. */
  | { kind: "voice:speech"; id: string; type: "part-progress"; index: number; t: number; d: number | null };

/** What the page (or side panel) knows that helps the API understand a command. */
export interface VoiceCommandContext {
  host?: string;
  companies?: Array<{ symbol: string; mentions: number }>;
  lastGuard?: { code: string; message: string } | null;
  lastReply?: string | null;
  openCard?: string | null;
}

export type VoiceRequest =
  | { kind: "voice:start"; session: string; lang: string; context: VoiceCommandContext; vault?: string; listen?: ListenOptions }
  | { kind: "voice:stop"; session: string }
  | { kind: "voice:abort"; session: string }
  | { kind: "voice:speak"; id: string; text: string }
  | { kind: "voice:hush" }
  /** The panel opened: have the API warm its provider connections for a command that may be coming. */
  | { kind: "voice:warm"; panel?: boolean }
  /** One sentence of a reply spoken in parts, as soon as it's written (the first starts playing at once). */
  | { kind: "voice:speak-part"; id: string; index: number; text: string }
  /** No more parts: the reply has `total` of them. */
  | { kind: "voice:speak-end"; id: string; total: number }
  /** From the offscreen document: getUserMedia failed with this error name. The background answers with the code. */
  | { kind: "voice:mic-failed"; name: string }
  /** From the offscreen document: the microphone opened. */
  | { kind: "voice:mic-worked" };

/** Background -> offscreen document. The background adds the API's address, which the offscreen document can't read. */
export type OffscreenRequest =
  | { kind: "offscreen:start"; session: string; lang: string; api: string; context: VoiceCommandContext; vault?: string; listen?: ListenOptions }
  | { kind: "offscreen:stop"; session: string }
  | { kind: "offscreen:abort"; session: string }
  | { kind: "offscreen:speak"; id: string; text: string; api: string }
  | { kind: "offscreen:hush" }
  | { kind: "offscreen:warm"; api: string; panel?: boolean }
  | { kind: "offscreen:speak-part"; id: string; index: number; text: string; api: string }
  | { kind: "offscreen:speak-end"; id: string; total: number };
