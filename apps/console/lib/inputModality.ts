"use client";
/**
 * Keyboard or pointer: the last way the user interacted, on <html data-input>, so focus rings show for keyboard users
 * only. A pointer press sets "pointer"; any navigation key (Tab, arrows, Enter, Space, Escape) sets "keyboard".
 */
const KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "Escape", "Home", "End"]);

export function trackInputModality(root: HTMLElement = document.documentElement): () => void {
  const onPointer = () => {
    root.dataset.input = "pointer";
  };
  const onKey = (e: KeyboardEvent) => {
    if (KEYS.has(e.key)) root.dataset.input = "keyboard";
  };
  root.dataset.input = "pointer";
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("keydown", onKey, true);
  return () => {
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("keydown", onKey, true);
  };
}
