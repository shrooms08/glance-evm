/** Two hotkeys, two verbs: Option+G taps to glance (never listens), Option+V holds to talk. */
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useHotkeys } from "../components/useHotkeys";
import { endsVoiceHold, glanceLine, hotkeyDown, hotkeyError, keyLabel, type KeyLike } from "../lib/hotkeys";

const KEYS = { glance: "G", voice: "V" };
const key = (code: string, extra: Partial<KeyLike> = {}): KeyLike => ({ code, key: "", altKey: true, ctrlKey: false, metaKey: false, repeat: false, ...extra });

describe("hotkeyDown", () => {
  it("Option+G glances and Option+V talks", () => {
    expect(hotkeyDown(key("KeyG"), KEYS)).toBe("glance");
    expect(hotkeyDown(key("KeyV"), KEYS)).toBe("voice");
  });
  it("needs Option, and ignores Ctrl, Cmd and auto-repeat", () => {
    expect(hotkeyDown(key("KeyG", { altKey: false }), KEYS)).toBeNull();
    expect(hotkeyDown(key("KeyV", { metaKey: true }), KEYS)).toBeNull();
    expect(hotkeyDown(key("KeyV", { ctrlKey: true }), KEYS)).toBeNull();
    expect(hotkeyDown(key("KeyV", { repeat: true }), KEYS)).toBeNull();
    expect(hotkeyDown(key("KeyX"), KEYS)).toBeNull();
  });
  it("follows remapped letters", () => {
    expect(hotkeyDown(key("KeyB"), { glance: "G", voice: "B" })).toBe("voice");
    expect(hotkeyDown(key("KeyV"), { glance: "G", voice: "B" })).toBeNull();
  });
  it("releasing the letter or Option ends a hold", () => {
    expect(endsVoiceHold({ code: "KeyV", key: "" }, KEYS)).toBe(true);
    expect(endsVoiceHold({ code: "AltLeft", key: "Alt" }, KEYS)).toBe(true);
    expect(endsVoiceHold({ code: "KeyG", key: "" }, KEYS)).toBe(false);
  });
  it("labels keys for the hints", () => {
    expect(keyLabel("v")).toBe("⌥ V");
  });
});

describe("hotkeyError", () => {
  it("accepts two different letters", () => {
    expect(hotkeyError("G", "V")).toEqual({});
  });
  it("rejects the same letter twice, and non-letters", () => {
    expect(hotkeyError("G", "G").voice).toMatch(/different letter/);
    expect(hotkeyError("", "V").glance).toMatch(/single letter/);
    expect(hotkeyError("G", "1").voice).toMatch(/single letter/);
  });
});

describe("glanceLine", () => {
  it("says what was found", () => {
    expect(glanceLine("cnbc.com", [{ name: "Tesla", mentions: 16 }])).toBe("Reading cnbc.com, 1 name found, Tesla 16×");
  });
  it("lists up to three names, most mentioned first", () => {
    const found = [
      { name: "Amazon", mentions: 2 },
      { name: "Tesla", mentions: 16 },
      { name: "AMD", mentions: 1 },
      { name: "Netflix", mentions: 5 },
    ];
    expect(glanceLine("reuters.com", found)).toBe("Reading reuters.com, 4 names found, Tesla 16×, Netflix 5×, Amazon 2×");
  });
  it("says so when nothing is found", () => {
    expect(glanceLine("example.com", [])).toBe("Reading example.com, no names found");
  });
});

describe("useHotkeys", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let cleanup = () => {};
  afterEach(() => cleanup());

  function mount(keys = KEYS) {
    const calls: string[] = [];
    const div = document.createElement("div");
    document.body.append(div);
    const root = createRoot(div);
    let n = 0;
    function Probe({ tick }: { tick: number }) {
      // New handler identities on every render, as in the real components.
      useHotkeys(keys, { onGlance: () => calls.push(`glance${tick}`), onVoiceStart: () => calls.push("voice:start"), onVoiceEnd: () => calls.push("voice:end") });
      return null;
    }
    const render = () => act(() => root.render(createElement(Probe, { tick: n++ })));
    render();
    cleanup = () => act(() => root.unmount());
    return { calls, rerender: render };
  }
  const press = (type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent(type, { code, altKey: type === "keydown", bubbles: true, ...init }));
    });

  it("a tap of Option+G glances and never starts listening", () => {
    const { calls } = mount();
    press("keydown", "KeyG");
    press("keyup", "KeyG");
    expect(calls).toEqual(["glance0"]);
  });

  it("holding Option+V listens until release, through re-renders and key repeat", () => {
    const { calls, rerender } = mount();
    press("keydown", "KeyV");
    rerender(); // listening starts and the component re-renders mid-hold
    press("keydown", "KeyV", { repeat: true });
    press("keydown", "KeyV", { repeat: true });
    expect(calls).toEqual(["voice:start"]);
    press("keyup", "KeyV");
    expect(calls).toEqual(["voice:start", "voice:end"]);
  });

  it("releasing Option first also sends", () => {
    const { calls } = mount();
    press("keydown", "KeyV");
    press("keyup", "AltLeft", { key: "Alt" });
    expect(calls).toEqual(["voice:start", "voice:end"]);
  });

  it("switching windows mid-hold counts as a release", () => {
    const { calls } = mount();
    press("keydown", "KeyV");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(calls).toEqual(["voice:start", "voice:end"]);
  });

  it("uses remapped keys", () => {
    const { calls } = mount({ glance: "G", voice: "B" });
    press("keydown", "KeyV");
    press("keydown", "KeyB");
    press("keyup", "KeyB");
    expect(calls).toEqual(["voice:start", "voice:end"]);
  });
});
