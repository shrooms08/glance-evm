/**
 * Option+V must never drop silently back to idle: every way recognition can end becomes words or a named reason, a
 * release before recognition starts still stops it, and nothing can leave the orb stuck listening.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";

import { listen } from "../lib/voice";
import { MAX_LISTEN_MS, START_TIMEOUT_MS, startVoice } from "../lib/voiceClient";
import type { VoiceEvent } from "../lib/voiceMessages";
import { failureKind, reasonFor } from "../lib/voiceReasons";

/** A scriptable SpeechRecognition: the test plays the browser. */
class FakeRecognition {
  static last: FakeRecognition;
  lang = "";
  interimResults = false;
  continuous = false;
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  calls: string[] = [];
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.calls.push("start");
  }
  stop() {
    this.calls.push("stop");
  }
  abort() {
    this.calls.push("abort");
  }
  say(text: string) {
    this.onresult?.({ results: [Object.assign([{ transcript: text }], { isFinal: true })] });
  }
}

function record() {
  const got: string[] = [];
  return {
    got,
    h: {
      onStart: () => got.push("start"),
      onInterim: (t: string) => got.push(`interim:${t}`),
      onFinal: (t: string) => got.push(`final:${t}`),
      onError: (c: string) => got.push(`error:${c}`),
      onEnd: () => got.push("end"),
    },
  };
}

describe("listen() in the offscreen document or side panel", () => {
  beforeEach(() => vi.stubGlobal("webkitSpeechRecognition", FakeRecognition));
  afterEach(() => vi.unstubAllGlobals());

  it("no speech service: the browser ends recognition before it starts (Brave, some Chromium builds)", () => {
    const { got, h } = record();
    listen("en-US", h);
    FakeRecognition.last.onend!();
    expect(got).toEqual(["error:ended-before-start", "end"]);
  });

  it("the browser stops on its own right after starting, with nothing heard", () => {
    const { got, h } = record();
    listen("en-US", h);
    FakeRecognition.last.onstart!();
    FakeRecognition.last.onend!();
    expect(got).toEqual(["start", "error:ended-early", "end"]);
  });

  it("passes the browser's own errors through: denied, no microphone, no speech, network", () => {
    for (const code of ["not-allowed", "audio-capture", "no-speech", "network"]) {
      const { got, h } = record();
      listen("en-US", h);
      FakeRecognition.last.onstart!();
      FakeRecognition.last.onerror!({ error: code });
      FakeRecognition.last.onend!();
      expect(got).toEqual(["start", `error:${code}`, "end"]);
    }
  });

  it("an abort we didn't ask for is reported; our own abort is quiet", () => {
    const a = record();
    listen("en-US", a.h);
    FakeRecognition.last.onstart!();
    FakeRecognition.last.onerror!({ error: "aborted" });
    FakeRecognition.last.onend!();
    expect(a.got).toEqual(["start", "error:aborted", "end"]);

    const b = record();
    const l = listen("en-US", b.h)!;
    FakeRecognition.last.onstart!();
    l.abort();
    FakeRecognition.last.onerror!({ error: "aborted" });
    FakeRecognition.last.onend!();
    expect(b.got).toEqual(["start", "final:", "end"]);
  });

  it("released before it started: stops, and reports that nothing was heard rather than a failure", () => {
    const { got, h } = record();
    const l = listen("en-US", h)!;
    l.stop();
    FakeRecognition.last.onend!();
    expect(got).toEqual(["final:", "end"]);
  });

  it("words heard, then released: the transcript", () => {
    const { got, h } = record();
    const l = listen("en-US", h)!;
    FakeRecognition.last.onstart!();
    FakeRecognition.last.say("what's tesla at");
    l.stop();
    FakeRecognition.last.onend!();
    expect(got).toEqual(["start", "interim:what's tesla at", "final:what's tesla at", "end"]);
  });
});

describe("startVoice never hangs", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("gives up with a reason if recording never starts", async () => {
    vi.spyOn(browser.runtime, "sendMessage").mockResolvedValue(true as never);
    const { got, h } = record();
    startVoice(h);
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
    expect(got).toEqual(["error:no-start", "end"]);
  });

  it("stops a hold that never ends, and ends exactly once", async () => {
    const sent: Array<{ kind: string; session?: string }> = [];
    vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (m: unknown) => {
      sent.push(m as { kind: string });
      return true;
    });
    const { got, h } = record();
    startVoice(h);
    const session = sent[0]!.session!;
    await fakeBrowser.runtime.onMessage.trigger({ kind: "voice:event", session, seq: 1, type: "started" }, {}, () => {});
    await vi.advanceTimersByTimeAsync(MAX_LISTEN_MS);
    expect(sent.map((m) => m.kind)).toContain("voice:stop");
    await fakeBrowser.runtime.onMessage.trigger({ kind: "voice:event", session, seq: 2, type: "end" }, {}, () => {});
    await fakeBrowser.runtime.onMessage.trigger({ kind: "voice:event", session, seq: 3, type: "end" }, {}, () => {});
    expect(got.filter((g) => g === "end")).toHaveLength(1);
  });
});

describe("the panel tells the failures apart", () => {
  const chrome = { name: "Google Chrome" as const, version: "128" };
  const brave = { name: "Brave" as const, version: "1.70" };
  it("five kinds", () => {
    expect(failureKind("ended-before-start")).toBe("no-service");
    expect(failureKind("network")).toBe("no-service");
    expect(failureKind("not-allowed")).toBe("mic-denied");
    expect(failureKind("audio-capture")).toBe("no-mic");
    expect(failureKind("no-speech")).toBe("no-speech");
    expect(failureKind("aborted")).toBe("aborted");
  });
  it("each with its own sentence", () => {
    expect(reasonFor("ended-before-start", brave)).toMatch(/^Brave stopped listening straight away: it has no speech service/);
    expect(reasonFor("ended-early", chrome)).toMatch(/^Chrome stopped listening straight away/);
    expect(reasonFor("aborted", chrome)).toMatch(/^Listening was cut off/);
    expect(reasonFor("stop-timeout", chrome)).toMatch(/^Voice didn't answer/);
    const sentences = ["ended-before-start", "not-allowed", "audio-capture", "no-speech", "aborted"].map((c) => reasonFor(c, chrome));
    expect(new Set(sentences).size).toBe(5);
  });
});
