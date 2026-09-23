/**
 * Listens for the two Glance hotkeys (lib/hotkeys.ts). The hold state and the latest callbacks live in refs, so a
 * re-render in the middle of a hold (listening starts, the panel opens) can never lose the key-up that ends it.
 */
import { useEffect, useRef } from "react";

import { endsVoiceHold, hotkeyDown, type HotkeyLetters } from "../lib/hotkeys";

interface Handlers {
  onGlance(): void;
  onVoiceStart(): void;
  onVoiceEnd(): void;
  onEscape?(): void;
}

export function useHotkeys(keys: HotkeyLetters, handlers: Handlers, opts: { capture?: boolean } = {}) {
  const latest = useRef(handlers);
  latest.current = handlers;
  const holding = useRef(false);
  const capture = Boolean(opts.capture);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        latest.current.onEscape?.();
        return;
      }
      // Swallow repeats of our own combos too, so the page never sees them.
      const ours = e.altKey && !e.ctrlKey && !e.metaKey && (e.code === `Key${keys.glance}` || e.code === `Key${keys.voice}`);
      const action = hotkeyDown(e, keys);
      if (!ours) return;
      e.preventDefault();
      if (capture) e.stopPropagation();
      if (action === "glance") latest.current.onGlance();
      if (action === "voice" && !holding.current) {
        holding.current = true;
        latest.current.onVoiceStart();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (!holding.current || !endsVoiceHold(e, keys)) return;
      holding.current = false;
      latest.current.onVoiceEnd();
    };
    // Switching away mid-hold (Cmd+Tab) never delivers the key-up: treat it as a release.
    const blur = () => {
      if (!holding.current) return;
      holding.current = false;
      latest.current.onVoiceEnd();
    };
    window.addEventListener("keydown", down, capture);
    window.addEventListener("keyup", up, capture);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, capture);
      window.removeEventListener("keyup", up, capture);
      window.removeEventListener("blur", blur);
    };
  }, [keys.glance, keys.voice, capture]);
}
