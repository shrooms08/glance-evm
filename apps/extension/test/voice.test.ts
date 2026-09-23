/** Voice: honest reasons per browser, the speaking orb following the real utterance, and the offscreen relay client. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";

import { ORB_MOTION } from "../components/Orb";
import { speak } from "../lib/voice";
import { startVoice, STOP_TIMEOUT_MS } from "../lib/voiceClient";
import type { VoiceEvent } from "../lib/voiceMessages";
import { detectBrowser, reasonFor, type BrowserInfo } from "../lib/voiceReasons";

const CHROME: BrowserInfo = { name: "Google Chrome", version: "128" };
const CHROMIUM: BrowserInfo = { name: "Chromium", version: "128" };
const BRAVE: BrowserInfo = { name: "Brave", version: "128" };

describe("detectBrowser", () => {
  const ua = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
  it("tells Google Chrome from Chromium by the brands list", () => {
    expect(detectBrowser({ userAgent: ua, userAgentData: { brands: [{ brand: "Chromium", version: "128" }, { brand: "Google Chrome", version: "128" }] } })).toEqual(CHROME);
    expect(detectBrowser({ userAgent: ua, userAgentData: { brands: [{ brand: "Chromium", version: "128" }, { brand: "Not;A=Brand", version: "24" }] } })).toEqual(CHROMIUM);
  });
  it("spots Brave and Edge, which also claim to be Chromium", () => {
    expect(detectBrowser({ userAgent: ua, brave: {}, userAgentData: { brands: [{ brand: "Chromium", version: "128" }] } }).name).toBe("Brave");
    expect(detectBrowser({ userAgent: ua, userAgentData: { brands: [{ brand: "Chromium", version: "128" }, { brand: "Microsoft Edge", version: "128" }] } }).name).toBe("Microsoft Edge");
  });
  it("falls back to the user agent string", () => {
    expect(detectBrowser({ userAgent: ua })).toEqual({ name: "Google Chrome", version: "128" });
    expect(detectBrowser({ userAgent: `${ua} Edg/128.0` }).name).toBe("Microsoft Edge");
    expect(detectBrowser({ userAgent: "curl/8" }).name).toBe("Other");
  });
});

describe("reasonFor", () => {
  it("names the real cause, not a generic one", () => {
    expect(reasonFor("no-recognition", CHROMIUM)).toBe("This Chromium build has no speech recognition. Google Chrome has it. Type instead.");
    expect(reasonFor("no-recognition", BRAVE)).toMatch(/^Brave turns off speech recognition/);
    expect(reasonFor("mic-not-enabled", CHROME)).toBe("I need microphone access. Click “Enable voice” in Glance's settings, then try again.");
    expect(reasonFor("not-allowed", CHROME)).toMatch(/blocked for Glance/);
    expect(reasonFor("audio-capture", CHROME)).toMatch(/can't find a microphone/);
  });
  it("blames the speech service correctly per browser", () => {
    expect(reasonFor("network", CHROME)).toMatch(/^Chrome couldn't reach its speech service/);
    expect(reasonFor("network", CHROMIUM)).toBe("This Chromium build has no speech service. Google Chrome has it. Type instead.");
    expect(reasonFor("service-not-allowed", BRAVE)).toMatch(/^Brave blocks the speech service/);
  });
  it("always leaves typing as the way out", () => {
    for (const code of ["no-recognition", "mic-denied", "no-mic", "network", "no-speech", "offscreen-failed", "weird"]) {
      expect(reasonFor(code, CHROMIUM)).toMatch(/type|Enable voice|settings/i);
    }
  });
});

describe("orb motion", () => {
  it("speaking moves, and differently from thinking", () => {
    expect(ORB_MOTION.speaking).toBe("composing");
    expect(ORB_MOTION.thinking).toBe("working");
    expect(ORB_MOTION.speaking).not.toBe(ORB_MOTION.thinking);
    expect(ORB_MOTION.speaking).not.toBe(ORB_MOTION.listening);
  });
  it("idle keeps the eye mark", () => {
    expect(ORB_MOTION.idle).toBe("eye");
  });
  it("every state is visually distinct", () => {
    const motions = Object.values(ORB_MOTION);
    expect(new Set(motions).size).toBe(motions.length);
  });
});

/** A controllable speechSynthesis: the test decides when the voice starts and ends. */
class FakeUtterance {
  lang = "";
  rate = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

describe("speak", () => {
  let spoken: FakeUtterance[];
  beforeEach(() => {
    vi.useFakeTimers();
    spoken = [];
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", { speak: (u: FakeUtterance) => spoken.push(u), cancel: vi.fn(), getVoices: () => [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts the speaking state when the voice starts and stops it when the voice ends", async () => {
    const events: string[] = [];
    const done = speak("Confirm?", true, { onStart: () => events.push("start"), onEnd: () => events.push("end") });
    expect(events).toEqual([]); // queued, not yet audible: no speaking orb
    vi.advanceTimersByTime(800);
    spoken[0]!.onstart!();
    expect(events).toEqual(["start"]);
    vi.advanceTimersByTime(5_000); // a long sentence: no fixed timer ends it early
    expect(events).toEqual(["start"]);
    spoken[0]!.onend!();
    await done;
    expect(events).toEqual(["start", "end"]);
  });

  it("never shows speaking if the voice never starts", async () => {
    const events: string[] = [];
    const done = speak("Confirm?", true, { onStart: () => events.push("start"), onEnd: () => events.push("end") });
    vi.advanceTimersByTime(3_000);
    await done;
    expect(events).toEqual([]);
  });

  it("stops the speaking state on an error too", async () => {
    const events: string[] = [];
    const done = speak("Confirm?", true, { onStart: () => events.push("start"), onEnd: () => events.push("end") });
    spoken[0]!.onstart!();
    spoken[0]!.onerror!();
    await done;
    expect(events).toEqual(["start", "end"]);
  });

  it("does nothing when replies are off", async () => {
    const onStart = vi.fn();
    await speak("Confirm?", false, { onStart });
    expect(spoken).toEqual([]);
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("startVoice from a web page (offscreen relay)", () => {
  beforeEach(() => fakeBrowser.reset());

  it("asks the background to listen and follows its session's events, once each", async () => {
    const sent: unknown[] = [];
    vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (m: unknown) => {
      sent.push(m);
      return true;
    });
    const got: string[] = [];
    startVoice({
      onStart: () => got.push("start"),
      onInterim: (t) => got.push(`interim:${t}`),
      onFinal: (t) => got.push(`final:${t}`),
      onError: (c) => got.push(`error:${c}`),
      onEnd: () => got.push("end"),
    });
    const start = sent[0] as { kind: string; session: string };
    expect(start.kind).toBe("voice:start");
    const ev = (seq: number, body: object) => ({ kind: "voice:event", session: start.session, seq, ...body }) as VoiceEvent;
    await fakeBrowser.runtime.onMessage.trigger(ev(1, { type: "started" }), {}, () => {});
    await fakeBrowser.runtime.onMessage.trigger(ev(2, { type: "interim", text: "buy ten" }), {}, () => {});
    await fakeBrowser.runtime.onMessage.trigger(ev(2, { type: "interim", text: "buy ten" }), {}, () => {}); // duplicate
    await fakeBrowser.runtime.onMessage.trigger({ ...ev(3, { type: "final", text: "other" }), session: "someone-else" }, {}, () => {});
    await fakeBrowser.runtime.onMessage.trigger(ev(3, { type: "final", text: "buy ten dollars of Tesla" }), {}, () => {});
    await fakeBrowser.runtime.onMessage.trigger(ev(4, { type: "end" }), {}, () => {});
    expect(got).toEqual(["start", "interim:buy ten", "final:buy ten dollars of Tesla", "end"]);
  });

  it("reports offscreen-failed when the voice helper can't start", async () => {
    vi.spyOn(browser.runtime, "sendMessage").mockResolvedValue(false as never);
    const got: string[] = [];
    startVoice({ onInterim: () => {}, onFinal: () => {}, onError: (c) => got.push(c), onEnd: () => got.push("end") });
    await vi.waitFor(() => expect(got).toEqual(["offscreen-failed", "end"]));
  });

  it("never leaves the orb waiting if the voice server doesn't answer a release", async () => {
    vi.useFakeTimers();
    const sent: Array<{ kind: string; session?: string }> = [];
    vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (m: unknown) => {
      sent.push(m as { kind: string });
      return true;
    });
    const got: string[] = [];
    const s = startVoice({ onInterim: () => {}, onFinal: () => {}, onError: (c) => got.push(c), onEnd: () => got.push("end") });
    await fakeBrowser.runtime.onMessage.trigger({ kind: "voice:event", session: sent[0]!.session, seq: 1, type: "started" }, {}, () => {});
    s.stop();
    vi.advanceTimersByTime(STOP_TIMEOUT_MS);
    expect(got).toEqual(["stop-timeout", "end"]);
    expect(sent.map((m) => m.kind)).toEqual(["voice:start", "voice:stop", "voice:abort"]);
    vi.useRealTimers();
  });
});
