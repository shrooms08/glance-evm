/**
 * First run: the welcome and the three-step tour (each shown once, skippable), and the "Getting started" checklist,
 * whose items tick themselves off from real events. All kept in this browser only (chrome.storage.local).
 */
import { storage } from "wxt/utils/storage";

import { safely } from "./lifecycle";

/** The tour was finished or skipped (the welcome's "greeted" flag lives with the greeting, components/useGreeting). */
export const tourDone = storage.defineItem<boolean>("local:tourDone", { fallback: false });

export type ChecklistKey = "hover" | "ask" | "demoBuy";
export interface ChecklistState {
  hover?: boolean;
  ask?: boolean;
  demoBuy?: boolean;
  dismissed?: boolean;
}
export const checklist = storage.defineItem<ChecklistState>("local:checklist", { fallback: {} });

/** Ticks an item off (once; later calls do nothing). Never throws. */
export async function tick(item: ChecklistKey): Promise<void> {
  await safely(async () => {
    const c = await checklist.getValue();
    if (c[item]) return;
    await checklist.setValue({ ...c, [item]: true });
  }, Promise.resolve());
}

export async function dismissChecklist(): Promise<void> {
  await safely(async () => checklist.setValue({ ...(await checklist.getValue()), dismissed: true }), Promise.resolve());
}

export interface ChecklistRow {
  key: ChecklistKey | "vault";
  label: string;
  done: boolean;
}

/** The four items, in order; "create your vault" is done once Glance uses a vault that isn't the demo. */
export function checklistRows(state: ChecklistState, ownVault: boolean): ChecklistRow[] {
  return [
    { key: "hover", label: "Hover an underlined company", done: Boolean(state.hover) },
    { key: "ask", label: "Ask Glance a question", done: Boolean(state.ask) },
    { key: "demoBuy", label: "Make a demo buy", done: Boolean(state.demoBuy) },
    { key: "vault", label: "Create your own vault", done: ownVault },
  ];
}

/** The tour's three steps (the voice key is the one the user has set). */
export function tourSteps(voiceKey: string): Array<{ title: string; anchor: "underline" | "orb" }> {
  return [
    { title: "I underline companies on any page", anchor: "underline" },
    { title: "Hover one to see its price, chart and a buy button", anchor: "underline" },
    { title: `Hold ${voiceKey} to ask me anything`, anchor: "orb" },
  ];
}

/** What a page shows on load: the welcome (first ever), the tour (welcomed, tour not finished or skipped), or nothing. */
export function firstRun(wasGreeted: boolean, toured: boolean): "welcome" | "tour" | null {
  if (!wasGreeted) return "welcome";
  return toured ? null : "tour";
}

/** Whether the user asked for less motion (the tour then appears without animating). */
export function prefersReducedMotion(): boolean {
  return safely(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, false);
}
