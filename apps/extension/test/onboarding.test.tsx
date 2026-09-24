/**
 * First run: the welcome and the tour each show once (skippable), the tour's steps, the coach mark stays on screen, the
 * "Getting started" checklist ticks itself off from real events and can be hidden, the demo vault is the default, and
 * a page with no companies says where to try Glance instead.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Checklist, DemoNotice, EMPTY_PAGE_LINE, EmptyPage, placeCoach, Tour } from "../components/Onboarding";
import { checklist, checklistRows, dismissChecklist, firstRun, tick, tourSteps } from "../lib/onboarding";
import { DEFAULT_VAULT, DEMO_VAULTS, vaultAddress } from "../lib/settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, unmount: () => act(() => root.unmount()) };
}
const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")].map((b) => b.textContent);

beforeEach(() => fakeBrowser.reset());
afterEach(() => {
  document.body.innerHTML = "";
});

describe("welcome and tour, once each", () => {
  it("first ever: the welcome; then the tour until it's finished or skipped; then nothing", () => {
    expect(firstRun(false, false)).toBe("welcome");
    expect(firstRun(true, false)).toBe("tour");
    expect(firstRun(true, true)).toBeNull();
  });

  it("three steps: underlines, hover, hold the voice key (the user's own key)", () => {
    expect(tourSteps("⌥V").map((s) => s.title)).toEqual(["I underline companies on any page", "Hover one to see its price, chart and a buy button", "Hold ⌥V to ask me anything"]);
    expect(tourSteps("⌥B")[2]!.title).toBe("Hold ⌥B to ask me anything");
  });

  it("a step can be skipped; the last says 'Got it'; reduced motion means no animation", () => {
    const onSkip = vi.fn();
    const onNext = vi.fn();
    const anchor = { left: 100, top: 100, width: 80, height: 20 };
    const first = render(createElement(Tour, { step: 0, total: 3, title: "I underline companies on any page", anchor, onNext, onSkip, reducedMotion: true }));
    expect(buttons(first.host)).toEqual(["Next", "Skip tour"]);
    act(() => (first.host.querySelectorAll("button")[1] as HTMLButtonElement).click());
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(first.host.querySelector(".g-coach")!.getAttribute("data-motion")).toBe("reduce");
    first.unmount();
    const last = render(createElement(Tour, { step: 2, total: 3, title: "Hold ⌥V to ask me anything", anchor, onNext, onSkip, reducedMotion: false }));
    expect(buttons(last.host)).toEqual(["Got it"]);
    last.unmount();
  });

  it("the coach mark stays inside the viewport (below its anchor if there's room, else above)", () => {
    expect(placeCoach({ left: 10, top: 100, width: 50, height: 20 }, 1200, 800)).toEqual({ left: 12, top: 130, below: true });
    const near = placeCoach({ left: 1150, top: 740, width: 48, height: 48 }, 1200, 800);
    expect(near.below).toBe(false);
    expect(near.left + 280).toBeLessThanOrEqual(1200 - 12);
  });
});

describe("the Getting started checklist", () => {
  it("ticks itself off from real events, once each, and can be hidden", async () => {
    await tick("hover");
    await tick("hover");
    await tick("demoBuy");
    const state = await checklist.getValue();
    expect(state).toEqual({ hover: true, demoBuy: true });
    expect(checklistRows(state, false).map((r) => [r.key, r.done])).toEqual([
      ["hover", true],
      ["ask", false],
      ["demoBuy", true],
      ["vault", false],
    ]);
    // "Create your own vault" ticks once Glance uses a vault that isn't the demo.
    expect(checklistRows(state, true).at(-1)!.done).toBe(true);
    await dismissChecklist();
    expect((await checklist.getValue()).dismissed).toBe(true);
  });

  it("shows progress, and 'All done' when every item is ticked", () => {
    const onDismiss = vi.fn();
    const some = render(createElement(Checklist, { rows: checklistRows({ ask: true }, false), onDismiss }));
    expect(some.host.textContent).toContain("1 of 4");
    expect(buttons(some.host)).toEqual(["Hide"]);
    some.unmount();
    const all = render(createElement(Checklist, { rows: checklistRows({ hover: true, ask: true, demoBuy: true }, true), onDismiss }));
    expect(buttons(all.host)).toEqual(["All done: hide this"]);
    all.unmount();
  });
});

describe("demo by default", () => {
  it("with no vault set, Glance uses the open demo vault", async () => {
    expect(DEFAULT_VAULT).toBe(DEMO_VAULTS.paxosUSDG);
    expect(await vaultAddress.getValue()).toBe(DEMO_VAULTS.paxosUSDG);
  });

  it("the panel says so, with 'Set up my own vault'", () => {
    const onSetup = vi.fn();
    const { host, unmount } = render(createElement(DemoNotice, { onSetup }));
    expect(host.textContent).toContain("Demo vault: open for trying Glance");
    act(() => (host.querySelector("button") as HTMLButtonElement).click());
    expect(onSetup).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("a page with no companies says where to try Glance", () => {
    const { host, unmount } = render(createElement(EmptyPage));
    expect(host.textContent).toBe(EMPTY_PAGE_LINE);
    expect(EMPTY_PAGE_LINE).toBe("Nothing to underline here. Try a news article about Tesla, Amazon or AMD.");
    unmount();
  });
});
