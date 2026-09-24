/**
 * Keeping the mic permission: one offscreen document per browser session, created once and never closed by Glance
 * (USER_MEDIA only: Chrome closes an AUDIO_PLAYBACK document after 30 seconds of silence, which dropped Brave's
 * "until I close this site" grant); the Enable voice page never opens by itself once the mic has worked; a later refusal
 * gives the one-line hint with Glance's own site-settings address; settings' mic line; and a fixed extension ID.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import config from "../wxt.config";
import { EXTENSION_ID, idFromKey } from "../lib/extensionId";
import { OFFSCREEN_REASONS, offscreenKeeper } from "../lib/offscreenDoc";
import { decideMicFailure, micStatus, ALLOW_FOREVER_LINE } from "../lib/voicePrefs";
import { micSettingsUrl, reasonFor } from "../lib/voiceReasons";

describe("one offscreen document, kept", () => {
  it("is created once and reused for every utterance (even when asked for at once)", async () => {
    let open = 0;
    const create = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      open = 1;
    });
    const ensure = offscreenKeeper({ url: "chrome-extension://x/offscreen.html", existing: async () => open, create });
    await Promise.all([ensure(), ensure(), ensure()]);
    for (let i = 0; i < 5; i++) await ensure(); // five more Option+V presses
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("asks only for USER_MEDIA (no 30-second audio timeout), and Glance never closes it", () => {
    expect([...OFFSCREEN_REASONS]).toEqual(["USER_MEDIA"]);
    const sources = ["../entrypoints/background.ts", "../entrypoints/offscreen/main.ts", "../lib/voiceWorker.ts"].map((f) => readFileSync(resolve(import.meta.dirname, f), "utf8"));
    for (const s of sources) {
      expect(s).not.toMatch(/closeDocument/);
      expect(s).not.toMatch(/AUDIO_PLAYBACK/);
    }
  });

  it("after each utterance the microphone tracks stop (the document stays)", () => {
    const worker = readFileSync(resolve(import.meta.dirname, "../lib/voiceWorker.ts"), "utf8");
    expect(worker).toMatch(/getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
  });
});

describe("the Enable voice page", () => {
  const session = { setupOpened: false, hintShown: false };
  it("once the mic has worked, it never opens by itself again, however often the browser refuses", () => {
    const worked = { on: true, enabledAt: 1, workedAt: 2 };
    let s = session;
    for (let i = 0; i < 5; i++) {
      const d = decideMicFailure("NotAllowedError", worked, s);
      expect(d.openSetup).toBe(false);
      s = d.session;
    }
  });

  it("a refusal after it worked: the one-line hint once, with Glance's own settings address; then a short line", () => {
    const worked = { on: true, enabledAt: 1, workedAt: 2 };
    const first = decideMicFailure("NotAllowedError", worked, session);
    expect(first.code).toBe("mic-temporary");
    expect(decideMicFailure("NotAllowedError", worked, first.session).code).toBe("mic-blocked-again");
    const brave = { name: "Brave" as const, version: "1.80", engine: "Blink" as const };
    expect(micSettingsUrl(brave)).toBe(`brave://settings/content/siteDetails?site=chrome-extension%3A%2F%2F${EXTENSION_ID}`);
    expect(reasonFor("mic-temporary", brave as never)).toContain(`brave://settings/content/siteDetails?site=chrome-extension%3A%2F%2F${EXTENSION_ID}`);
  });

  it("the line shown before the browser asks", () => {
    expect(ALLOW_FOREVER_LINE).toBe("Brave and Chrome will ask to use your mic. Choose Allow, and in Brave choose 'Forever' so I don't ask again.");
  });

  it("settings' mic line, with its one fix", () => {
    expect(micStatus("granted", { workedAt: 1 })).toEqual({ label: "Mic: allowed", fix: "none" });
    expect(micStatus("prompt", { workedAt: 1 })).toEqual({ label: "Mic: ask each time (choose Forever)", fix: "enable" });
    expect(micStatus("denied", { workedAt: 1 })).toEqual({ label: "Mic: blocked", fix: "settings" });
  });
});

describe("a fixed extension ID", () => {
  const key = (config as { manifest: { key: string } }).manifest.key;

  it("the manifest carries the public key, and its ID is Glance's", async () => {
    expect(key).toMatch(/^MII[A-Za-z0-9+/=]+$/);
    expect(await idFromKey(key)).toBe(EXTENSION_ID);
    expect(EXTENSION_ID).toBe("gmcdcaoneeohbacbnafjdnkkoojgnogl");
  });

  it("the built extension has the same key (when a build is present)", () => {
    for (const out of [".output", ".output-e2e"]) {
      const file = resolve(import.meta.dirname, `../${out}/chrome-mv3/manifest.json`);
      if (existsSync(file)) expect((JSON.parse(readFileSync(file, "utf8")) as { key: string }).key).toBe(key);
    }
  });

  it("no private key anywhere in the extension's config", () => {
    const text = readFileSync(resolve(import.meta.dirname, "../wxt.config.ts"), "utf8");
    expect(text).not.toMatch(/PRIVATE KEY/);
  });
});
