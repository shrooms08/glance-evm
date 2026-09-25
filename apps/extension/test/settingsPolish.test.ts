/** Settings and panel polish: the side panel check (Arc has none), and the voice credit line. */
import { describe, expect, it } from "vitest";

import { sidePanelSupported } from "../lib/sidePanel";
import { VOICE_CREDIT } from "../entrypoints/options/VoiceSection";

describe("the side panel", () => {
  it("supported only where the API has open() (Chrome, Brave, Edge); not in Arc (no sidePanel at all)", () => {
    expect(sidePanelSupported({ open: () => Promise.resolve() })).toBe(true);
    expect(sidePanelSupported(undefined)).toBe(false);
    expect(sidePanelSupported({})).toBe(false);
  });
});

describe("the voice credit line", () => {
  it("names who does what", () => {
    expect(VOICE_CREDIT).toBe("Voice by AssemblyAI · Understanding by Claude · Speech by Deepgram");
  });
});

describe("Get Glance links", () => {
  it("point at the console the build is for: the latest zip and the install steps", async () => {
    const { installPageUrl, latestZipUrl } = await import("../lib/getGlance");
    expect(latestZipUrl("https://glance-evm-console.vercel.app/")).toBe("https://glance-evm-console.vercel.app/downloads/glance-extension-latest.zip");
    expect(installPageUrl("https://glance-evm-console.vercel.app")).toBe("https://glance-evm-console.vercel.app/install");
  });
});
