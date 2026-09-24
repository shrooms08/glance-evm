/**
 * The keys: hold ⌥V on the page to speak and let go to send (the talk command has no default key, so the browser
 * never takes ⌥V); ⌥G is a browser command that reaches the tab's Glance, and its activeTab grant is what a Show me
 * screenshot uses (no grant: no image, and the answer goes ahead).
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import config from "../wxt.config";
import { useHotkeys } from "../components/useHotkeys";
import { captureForShowMe, forwardCommand } from "../lib/commandRouting";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

function mountHotkeys() {
  const h = { onGlance: vi.fn(), onVoiceStart: vi.fn(), onVoiceEnd: vi.fn() };
  function Probe() {
    useHotkeys({ glance: "G", voice: "V" }, h);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Probe)));
  return { h, unmount: () => act(() => root.unmount()) };
}
const key = (type: "keydown" | "keyup", init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })));

describe("hold ⌥V to talk", () => {
  it("key down starts listening; key up sends it", () => {
    const { h, unmount } = mountHotkeys();
    key("keydown", { code: "KeyV", key: "√", altKey: true });
    expect(h.onVoiceStart).toHaveBeenCalledTimes(1);
    // Auto-repeat while held doesn't start it again.
    key("keydown", { code: "KeyV", key: "√", altKey: true, repeat: true });
    expect(h.onVoiceStart).toHaveBeenCalledTimes(1);
    expect(h.onVoiceEnd).not.toHaveBeenCalled();
    key("keyup", { code: "KeyV", key: "v", altKey: true });
    expect(h.onVoiceEnd).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("letting go of Option first sends it too", () => {
    const { h, unmount } = mountHotkeys();
    key("keydown", { code: "KeyV", altKey: true });
    key("keyup", { code: "AltLeft", key: "Alt" });
    expect(h.onVoiceEnd).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("the talk command has no default key, so the browser never takes ⌥V; ⌥G stays a command", () => {
    const commands = (config as { manifest: { commands: Record<string, { suggested_key?: unknown; description: string }> } }).manifest.commands;
    expect(commands.talk).toBeDefined();
    expect(commands.talk!.suggested_key).toBeUndefined();
    expect(commands.glance!.suggested_key).toEqual({ default: "Alt+G", mac: "Alt+G" });
  });
});

describe("⌥G, a browser command", () => {
  it("reaches the tab's Glance (and only glance and talk do)", () => {
    const send = vi.fn(async () => undefined);
    expect(forwardCommand("glance", 7, send)).toBe(true);
    expect(send).toHaveBeenCalledWith(7, { kind: "command", command: "glance" });
    expect(forwardCommand("something-else", 7, send)).toBe(false);
    expect(forwardCommand("glance", undefined, send)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a Show me screenshot uses the tab the grant covers; without it, no image and the answer goes ahead", async () => {
    expect(await captureForShowMe(3, async () => "data:image/jpeg;base64,AAAA")).toBe("data:image/jpeg;base64,AAAA");
    expect(await captureForShowMe(3, async () => Promise.reject(new Error("Either the '<all_urls>' or 'activeTab' permission is required.")))).toBeNull();
    expect(await captureForShowMe(undefined, async () => "x")).toBeNull();
  });
});
