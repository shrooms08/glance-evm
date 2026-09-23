/**
 * The voice relay. Speech recognition never runs in a web page (a site's Permissions-Policy can block the microphone
 * there). It runs in the extension's offscreen document; the background routes each session's events back to the
 * tab (or extension page) that asked.
 */
import type { VoiceCode } from "./voiceReasons";

/** `seq` increases per session, so a client that receives an event twice (broadcast and relay) can ignore repeats. */
export type VoiceEvent = { kind: "voice:event"; session: string; seq: number } & (
  | { type: "started" }
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; code: VoiceCode }
  | { type: "end" }
);

export type VoiceRequest =
  | { kind: "voice:start"; session: string; lang: string }
  | { kind: "voice:stop"; session: string }
  | { kind: "voice:abort"; session: string };

/** Background -> offscreen document. */
export type OffscreenRequest =
  | { kind: "offscreen:start"; session: string; lang: string }
  | { kind: "offscreen:stop"; session: string }
  | { kind: "offscreen:abort"; session: string }
  | { kind: "offscreen:diagnose" };
