/**
 * Linking UX: a trade that needs a linked browser says so on the card, with a button that starts linking; while the
 * owner signs, it waits; once linked, one tap sends the same buy. The status poll stops as soon as the API says linked.
 * Fakes only: a fake background answers the API calls.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_MESSAGES } from "@glance/core/session";

import { NeedsLink } from "../components/CompanyCard";
import type { Quote } from "../lib/api-types";
import { LINK_CODES, waitForLink } from "../lib/linking";
import { sessionLink } from "../lib/session";
const VAULT = "0x1111111111111111111111111111111111111111";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The fake background: answers /session/status (as the background would, from the API). */
const background = vi.hoisted(() => ({ reply: (_msg: { kind: string; path?: string }): unknown => undefined }));
vi.mock("../lib/lifecycle", () => ({ send: async (msg: { kind: string; path?: string }) => background.reply(msg) }));

function render(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, rerender: (next: ReturnType<typeof createElement>) => act(() => root.render(next)), unmount: () => act(() => root.unmount()) };
}
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

beforeEach(() => fakeBrowser.reset());
afterEach(() => {
  document.body.innerHTML = "";
});

const flow = (link: "idle" | "waiting" | "linked" | "failed", until?: number) => ({
  step: "needs-link" as const,
  amount: "10",
  quote: {} as Quote,
  code: "SESSION_REQUIRED",
  message: SESSION_MESSAGES.SESSION_REQUIRED,
  link,
  until,
});

describe("the card when a trade needs a linked browser", () => {
  it("says 'Link this browser to your vault first.' with 'Link Glance', which starts linking", () => {
    const onLink = vi.fn();
    const { host, unmount } = render(createElement(NeedsLink, { flow: flow("idle"), symbol: "TSLA", onLink, onRetry: () => {}, onCancel: () => {} }));
    expect(host.textContent).toContain("Link this browser to your vault first.");
    expect(host.textContent).toContain("It can never withdraw.");
    act(() => button(host, "Link Glance")!.click());
    expect(onLink).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("waits for the owner's signature, then retries the same buy in one tap", () => {
    const onRetry = vi.fn();
    const props = { symbol: "TSLA", onLink: () => {}, onRetry, onCancel: () => {} };
    const { host, rerender, unmount } = render(createElement(NeedsLink, { ...props, flow: flow("waiting") }));
    expect(button(host, "Waiting for the signature")!.disabled).toBe(true);
    rerender(createElement(NeedsLink, { ...props, flow: flow("linked", 1_790_000_000 + 30 * 86_400) }));
    expect(host.textContent).toMatch(/Linked until \d+ \w+ \d{4}/);
    act(() => button(host, "Buy $10 of TSLA")!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("which refusals offer linking: a missing or expired link (a bad signature or a replay don't)", () => {
    expect([...LINK_CODES].sort()).toEqual(["SESSION_EXPIRED", "SESSION_REQUIRED"]);
  });
});

describe("waiting for the link", () => {
  it("polls the API until the owner has linked this browser, then remembers until when", async () => {
    let calls = 0;
    background.reply = (msg) => {
      if (msg.kind !== "api" || !msg.path?.startsWith("/session/status")) return undefined;
      calls++;
      return calls < 3 ? { ok: true, status: 200, data: { linked: false, reason: "unknown" } } : { ok: true, status: 200, data: { linked: true, expiresAt: 1_792_000_000, linkedAt: 1_790_000_000 } };
    };
    const status = await waitForLink(VAULT, "0x1234567890123456789012345678901234567890", { sleep: async () => {} });
    expect(status).toEqual({ linked: true, expiresAt: 1_792_000_000 });
    expect(calls).toBe(3);
    expect(await sessionLink.getValue()).toEqual({ vault: VAULT, expiresAt: 1_792_000_000 });
  });

  it("stops when cancelled", async () => {
    const abort = new AbortController();
    abort.abort();
    expect(await waitForLink(VAULT, "0x1234567890123456789012345678901234567890", { signal: abort.signal })).toEqual({ linked: false, reason: "cancelled" });
  });
});
