/** The voice key in hold-to-talk (the default) and conversation mode, and the Settings credit line. */
import { describe, expect, it } from "vitest";

import { talkKey } from "../lib/talkMode";
import { sttCredit } from "../entrypoints/options/VoiceSection";

describe("the voice key", () => {
  it("hold-to-talk: down starts, up sends (whatever else is going on)", () => {
    expect(talkKey("down", { conversation: false, listening: false })).toBe("start");
    expect(talkKey("up", { conversation: false, listening: true })).toBe("stop");
  });

  it("conversation mode: a tap starts, the key coming up does nothing, a second tap sends now", () => {
    expect(talkKey("down", { conversation: true, listening: false })).toBe("start");
    expect(talkKey("up", { conversation: true, listening: true })).toBeNull();
    expect(talkKey("down", { conversation: true, listening: true })).toBe("stop");
  });
});

describe("Settings: who listens", () => {
  it("names the provider the API reports", () => {
    expect(sttCredit({ provider: "assemblyai", model: "universal-3-5-pro" })).toBe("Speech recognition by AssemblyAI");
    expect(sttCredit({ provider: "deepgram", model: "nova-3" })).toBe("Speech recognition by Deepgram");
    expect(sttCredit(null)).toBeNull();
  });
});
