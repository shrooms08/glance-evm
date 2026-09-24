/**
 * Voice is enabled once and stays enabled.
 *
 * The microphone permission belongs to the extension's own origin (chrome-extension://<id>): it's granted once, from
 * the settings page's "Enable voice", and the offscreen document (same origin) reuses it without asking. What Glance
 * remembers, in chrome.storage.local, is the user's choice and whether the microphone has ever actually worked:
 *
 *   voiceState   { on, enabledAt, workedAt }: survives reloads of the extension, browser restarts and new tabs.
 *
 * A "prompt" answer from navigator.permissions.query is not trusted on its own (Brave, and offscreen documents, can say
 * "prompt" while getUserMedia would succeed). On Option+V the offscreen document simply tries getUserMedia; only a real
 * failure changes anything, and decideMicFailure() says what to show:
 *
 *   NotAllowedError, never worked before    "Enable voice" (the settings page opens by itself at most once per browser
 *                                           session; after that the line just says where the button is)
 *   NotAllowedError, after it had worked    the browser only allowed it for a while (Brave's temporary grants): one
 *                                           plain line with the settings address to copy, once per session; later
 *                                           failures that session get a short line, never another prompt
 *   NotFoundError / OverconstrainedError    no microphone
 *
 * Only extension pages and the background use this module (the offscreen document has no chrome.storage: it asks the
 * background).
 */
import { storage } from "wxt/utils/storage";

import type { VoiceCode } from "./voiceReasons";

export { micSettingsUrl, micTemporaryLine } from "./voiceReasons";

export interface VoiceState {
  /** The user turned voice on (Enable voice), or it has worked. */
  on: boolean;
  enabledAt: number | null;
  /** The last time the microphone actually opened. */
  workedAt: number | null;
}

export const voiceState = storage.defineItem<VoiceState>("local:voiceState", { fallback: { on: false, enabledAt: null, workedAt: null } });

/** Per browser session (chrome.storage.session): cleared when the browser restarts. */
export interface MicSession {
  /** The settings page was opened automatically for "Enable voice". */
  setupOpened: boolean;
  /** The "only allowed for a while" line was shown. */
  hintShown: boolean;
}

export const micSession = storage.defineItem<MicSession>("session:micSession", { fallback: { setupOpened: false, hintShown: false } });

export interface MicDecision {
  code: VoiceCode;
  /** Open the settings page at "Enable voice" now (at most once per browser session). */
  openSetup: boolean;
  session: MicSession;
}

/** What a getUserMedia failure means, and what to do about it. Pure: the caller reads and writes the state. */
export function decideMicFailure(errorName: string, state: VoiceState, session: MicSession): MicDecision {
  if (errorName === "NotFoundError" || errorName === "OverconstrainedError") return { code: "no-mic", openSetup: false, session };
  if (errorName !== "NotAllowedError" && errorName !== "SecurityError") return { code: "audio-capture", openSetup: false, session };
  if (state.workedAt !== null) {
    // It worked before and now it doesn't: the browser's grant ran out. Say how to make it stick, once.
    if (!session.hintShown) return { code: "mic-temporary", openSetup: false, session: { ...session, hintShown: true } };
    return { code: "mic-blocked-again", openSetup: false, session };
  }
  // Never worked: voice needs enabling. Open the settings page for it once per browser session, never in a loop.
  if (!session.setupOpened) return { code: "mic-not-enabled", openSetup: true, session: { ...session, setupOpened: true } };
  return { code: "mic-not-enabled", openSetup: false, session };
}

/** The microphone opened: voice is on, and it has worked. */
export async function markMicWorked(now = Date.now()) {
  const s = await voiceState.getValue();
  await voiceState.setValue({ on: true, enabledAt: s.enabledAt ?? now, workedAt: now });
}

/** "Enable voice" succeeded in settings. */
export async function markVoiceEnabled(now = Date.now()) {
  const s = await voiceState.getValue();
  await voiceState.setValue({ on: true, enabledAt: now, workedAt: now });
}

/** Applies decideMicFailure to the stored state; returns the code to show and whether to open the setup page. */
export async function onMicFailure(errorName: string): Promise<MicDecision> {
  const [state, session] = await Promise.all([voiceState.getValue(), micSession.getValue().catch(() => ({ setupOpened: false, hintShown: false }))]);
  const d = decideMicFailure(errorName, state, session);
  if (d.session !== session) await micSession.setValue(d.session).catch(() => {});
  return d;
}
