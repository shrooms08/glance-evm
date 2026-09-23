/**
 * Listens for the two Glance hotkeys (lib/hotkeys.ts). Letters are matched on event.code (KeyG, KeyV), never on
 * event.key: on a Mac, Option+V types "√" and Option+G "©". The hold state and the latest callbacks live in refs, so
 * a re-render in the middle of a hold (listening starts, the panel opens) can never lose the key-up that ends it.
 *
 * A window blur does not end a hold: starting the microphone can blur the page (macOS's first-use prompt, focus moving
 * into an iframe), which used to drop listening straight back to idle. If Option really was released while the page
 * had no focus, the next key or pointer event without Option ends the hold, and the voice client's own time limits
 * cover the rest.
 */
import { useEffect, useRef } from "react";

import { codeFor, endsVoiceHold, hotkeyDown, type HotkeyLetters } from "../lib/hotkeys";

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
      optionGone(e);
      if (e.key === "Escape") {
        latest.current.onEscape?.();
        return;
      }
      // Swallow repeats of our own combos too, so the page never sees them.
      const ours = e.altKey && !e.ctrlKey && !e.metaKey && (e.code === codeFor(keys.glance) || e.code === codeFor(keys.voice));
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
      if (!holding.current) return;
      if (!endsVoiceHold(e, keys)) return optionGone(e);
      holding.current = false;
      latest.current.onVoiceEnd();
    };
    // Option was let go while we weren't looking (Cmd+Tab away and back): the first event without it ends the hold.
    const optionGone = (e: KeyboardEvent | PointerEvent) => {
      if (!holding.current || e.altKey) return;
      holding.current = false;
      latest.current.onVoiceEnd();
    };
    window.addEventListener("keydown", down, capture);
    window.addEventListener("keyup", up, capture);
    window.addEventListener("pointerdown", optionGone, true);
    window.addEventListener("pointermove", optionGone, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", down, capture);
      window.removeEventListener("keyup", up, capture);
      window.removeEventListener("pointerdown", optionGone, true);
      window.removeEventListener("pointermove", optionGone, true);
    };
  }, [keys.glance, keys.voice, capture]);
}
