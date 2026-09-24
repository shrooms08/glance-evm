/**
 * The first time Glance opens (once per browser profile, remembered in chrome.storage.local): one or two sentences on
 * what Glance can do, and the two shortcuts. Never again after that.
 */
import { GREETING } from "@glance/core/persona";
import { useEffect } from "react";
import { storage } from "wxt/utils/storage";

import { keyLabel } from "../lib/hotkeys";
import { safely } from "../lib/lifecycle";
import { useGlance } from "./context";

export const greeted = storage.defineItem<boolean>("local:greeted", { fallback: false });

/** Returns the greeting once (and records it), or null after that. */
export async function takeGreeting(glanceKey: string, voiceKey: string): Promise<string | null> {
  if (await greeted.getValue()) return null;
  await greeted.setValue(true);
  return GREETING(glanceKey, voiceKey);
}

/** Shows the greeting in the orb's line the first time. `when` lets a surface wait until it's visible. */
export function useGreeting(when = true) {
  const g = useGlance();
  const { setOrb, glanceKey, voiceKey } = g;
  useEffect(() => {
    if (!when) return;
    void safely(() => takeGreeting(keyLabel(glanceKey), keyLabel(voiceKey)), Promise.resolve(null)).then((line) => {
      if (line) setOrb({ state: "idle", line, meta: "Hello" });
    });
  }, [when, setOrb, glanceKey, voiceKey]);
}
