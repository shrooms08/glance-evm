/**
 * Voice is enabled once and stays enabled: the choice survives a restart, a working microphone never shows "Enable
 * voice", a grant that ran out (Brave) gets one plain line with the settings address, and the settings page never opens
 * by itself more than once per browser session.
 */
import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it } from "vitest";

import {
  decideMicFailure,
  markMicWorked,
  markVoiceEnabled,
  micSession,
  micSettingsUrl,
  onMicFailure,
  voiceState,
  type MicSession,
  type VoiceState,
} from "../lib/voicePrefs";
import { reasonFor } from "../lib/voiceReasons";

const NEVER: VoiceState = { on: false, enabledAt: null, workedAt: null };
const WORKED: VoiceState = { on: true, enabledAt: 1, workedAt: 2 };
const FRESH: MicSession = { setupOpened: false, hintShown: false };
const BRAVE = { name: "Brave" as const, version: "1.84" };

beforeEach(() => fakeBrowser.reset());

describe("the voice choice persists", () => {
  it("Enable voice is kept in chrome.storage.local, and survives a restart (session storage cleared)", async () => {
    await markVoiceEnabled(1_000);
    await micSession.setValue({ setupOpened: true, hintShown: true });
    // A browser restart: chrome.storage.session is cleared, chrome.storage.local isn't.
    await fakeBrowser.storage.session.clear();
    expect(await voiceState.getValue()).toEqual({ on: true, enabledAt: 1_000, workedAt: 1_000 });
    expect(await micSession.getValue()).toEqual(FRESH);
  });

  it("a microphone that opens turns voice on and records when it last worked", async () => {
    await markMicWorked(5_000);
    expect(await voiceState.getValue()).toEqual({ on: true, enabledAt: 5_000, workedAt: 5_000 });
    await markMicWorked(9_000);
    expect(await voiceState.getValue()).toEqual({ on: true, enabledAt: 5_000, workedAt: 9_000 });
  });
});

describe("what a microphone failure shows", () => {
  it("never worked: Enable voice, opening settings by itself only once per browser session", () => {
    const first = decideMicFailure("NotAllowedError", NEVER, FRESH);
    expect(first).toMatchObject({ code: "mic-not-enabled", openSetup: true });
    const second = decideMicFailure("NotAllowedError", NEVER, first.session);
    expect(second).toMatchObject({ code: "mic-not-enabled", openSetup: false });
    expect(decideMicFailure("NotAllowedError", NEVER, second.session).openSetup).toBe(false);
  });

  it("worked before, refused now: the Brave line with the address, once; then a short line, and no prompt at all", () => {
    const first = decideMicFailure("NotAllowedError", WORKED, FRESH);
    expect(first).toMatchObject({ code: "mic-temporary", openSetup: false });
    expect(reasonFor(first.code, BRAVE)).toBe("Brave only allowed the mic for a while. Open brave://settings/content/siteDetails?site=chrome-extension%3A%2F%2Fgmcdcaoneeohbacbnafjdnkkoojgnogl and set Microphone to Allow.");
    const again = decideMicFailure("NotAllowedError", WORKED, first.session);
    expect(again).toMatchObject({ code: "mic-blocked-again", openSetup: false });
    expect(reasonFor(again.code, BRAVE)).toContain("brave://settings/content/siteDetails?site=chrome-extension%3A%2F%2Fgmcdcaoneeohbacbnafjdnkkoojgnogl");
  });

  it("no microphone is its own answer", () => {
    expect(decideMicFailure("NotFoundError", WORKED, FRESH)).toMatchObject({ code: "no-mic", openSetup: false });
    expect(micSettingsUrl({ name: "Google Chrome" })).toBe("chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2Fgmcdcaoneeohbacbnafjdnkkoojgnogl");
  });

  it("applied to storage: repeated failures in one session open the settings page once", async () => {
    const opens = [];
    for (let i = 0; i < 4; i++) if ((await onMicFailure("NotAllowedError")).openSetup) opens.push(i);
    expect(opens).toEqual([0]);
    // After a restart it may open once more, never in a loop.
    await fakeBrowser.storage.session.clear();
    expect((await onMicFailure("NotAllowedError")).openSetup).toBe(true);
    expect((await onMicFailure("NotAllowedError")).openSetup).toBe(false);
  });

  it("the hint is shown once per session, after an earlier success", async () => {
    await markMicWorked(1);
    expect((await onMicFailure("NotAllowedError")).code).toBe("mic-temporary");
    expect((await onMicFailure("NotAllowedError")).code).toBe("mic-blocked-again");
    expect((await onMicFailure("NotAllowedError")).code).toBe("mic-blocked-again");
  });
});
