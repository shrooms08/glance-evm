/**
 * Reloading or updating Glance under an open tab: the old content script must shut down once, quietly (no uncaught
 * errors), and leave a refresh notice where the orb was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { ContentScriptContext } from "wxt/utils/content-script-context";

import { api } from "../lib/api";
import { isInvalidatedError, isContextLost, resetLifecycleForTests, safely, send } from "../lib/lifecycle";
import { installPageLifecycle } from "../lib/pageLifecycle";
import { NOTICE_TAG, NOTICE_TEXT, rememberOrbAnchor } from "../lib/updatedNotice";

const invalidated = () => new Error("Extension context invalidated.");
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Simulates Chrome after a reload: runtime.id is gone and every call throws. */
function invalidate() {
  Object.defineProperty(browser.runtime, "id", { value: undefined, configurable: true });
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(() => {
    throw invalidated();
  });
}

function notice() {
  return document.querySelector(NOTICE_TAG);
}

describe("extension context invalidation", () => {
  let ports: Array<{ name: string; fire(): void }>;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fakeBrowser.reset();
    resetLifecycleForTests();
    Object.defineProperty(browser.runtime, "id", { value: "glance-test", configurable: true });
    document.querySelector(NOTICE_TAG)?.remove();
    ports = [];
    vi.spyOn(browser.runtime, "connect").mockImplementation(((info?: { name?: string }) => {
      const listeners: Array<() => void> = [];
      ports.push({ name: info?.name ?? "", fire: () => listeners.forEach((l) => l()) });
      return { onDisconnect: { addListener: (l: () => void) => listeners.push(l) }, disconnect: () => {} };
    }) as never);
    errors = vi.spyOn(console, "error");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setup() {
    const ctx = new ContentScriptContext("glance-test", { noScriptStartedPostMessage: true });
    const removeUi = vi.fn();
    const stopUnderliner = vi.fn();
    // What WXT registers for us: removing the shadow-root UI (unmounting React and its listeners), and our underliner.
    ctx.onInvalidated(removeUi);
    ctx.onInvalidated(stopUnderliner);
    installPageLifecycle(ctx);
    return { ctx, removeUi, stopUnderliner };
  }

  it("recognises Chrome's error", () => {
    expect(isInvalidatedError(invalidated())).toBe(true);
    expect(isInvalidatedError("Extension context invalidated.")).toBe(true);
    expect(isInvalidatedError(new Error("Could not establish connection"))).toBe(false);
  });

  it("an API call after a reload shuts the page UI down once and shows the refresh notice", async () => {
    const { ctx, removeUi, stopUnderliner } = setup();
    rememberOrbAnchor({ right: 40, bottom: 30 });
    invalidate();

    // The call that finds out: it must not throw or reject, it simply never answers.
    const pending = api.health();
    let settled = false;
    void pending.then(() => (settled = true));
    await tick();

    expect(isContextLost()).toBe(true);
    expect(ctx.isInvalid).toBe(true);
    expect(removeUi).toHaveBeenCalledTimes(1);
    expect(stopUnderliner).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    const host = notice();
    expect(host).not.toBeNull();
    const box = host!.shadowRoot!.querySelector(".n") as HTMLElement;
    expect(box.textContent).toContain(NOTICE_TEXT);
    expect(box.getAttribute("role")).toBe("status");
    expect(box.style.right).toBe("40px"); // where the orb was
    expect([...box.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Refresh", "×"]);

    // Everything after is inert: no more calls go out, no second notice, nothing logged.
    const calls = vi.mocked(browser.runtime.sendMessage).mock.calls.length;
    void send({ kind: "panel:isOpen" });
    void api.catalog();
    await tick();
    expect(vi.mocked(browser.runtime.sendMessage).mock.calls.length).toBe(calls);
    expect(document.querySelectorAll(NOTICE_TAG)).toHaveLength(1);
    expect(removeUi).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("notices promptly from the port disconnect, before any user action", async () => {
    const { removeUi } = setup();
    expect(ports.map((p) => p.name)).toEqual(["glance:content"]);
    invalidate();
    ports[0]!.fire();
    await tick();
    expect(removeUi).toHaveBeenCalledTimes(1);
    expect(notice()).not.toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it("a port that drops while Glance is still installed (idle service worker) just reconnects", async () => {
    vi.useFakeTimers();
    const { removeUi } = setup();
    ports[0]!.fire();
    vi.advanceTimersByTime(1_000);
    expect(ports).toHaveLength(2);
    expect(removeUi).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
    vi.useRealTimers();
  });

  it("the Refresh button reloads the page", async () => {
    setup();
    invalidate();
    void send({ kind: "api" });
    await tick();
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, reload }, configurable: true });
    (notice()!.shadowRoot!.querySelector("button.go") as HTMLButtonElement).click();
    expect(reload).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, "location", { value: original, configurable: true });
  });

  it("stray invalidated rejections from library code are swallowed, not logged", async () => {
    setup();
    invalidate();
    const event = new Event("unhandledrejection", { cancelable: true }) as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", { value: invalidated() });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await tick();
    expect(notice()).not.toBeNull();
  });

  it("safely() turns a throwing storage call into the fallback and a quiet shutdown", () => {
    setup();
    invalidate();
    const out = safely(() => {
      throw invalidated();
    }, "fallback");
    expect(out).toBe("fallback");
    expect(isContextLost()).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it("a newer copy of the script clears the old notice", () => {
    setup();
    invalidate();
    void send({ kind: "api" });
    expect(notice()).not.toBeNull();
    resetLifecycleForTests();
    Object.defineProperty(browser.runtime, "id", { value: "glance-test", configurable: true });
    installPageLifecycle(new ContentScriptContext("glance-test-2", { noScriptStartedPostMessage: true }));
    expect(notice()).toBeNull();
  });
});
