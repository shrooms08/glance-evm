/**
 * The "talk" browser command, only when the user has assigned it a key on the browser's shortcuts page (it has no
 * default: ⌥V is hold to speak, release to send, on the page itself). A command fires on key-down only, so:
 *   - a tap starts listening, and the next tap sends it (press to talk, press again to send);
 *   - a key held down repeats the command (where the browser repeats it): listening ends once the repeats stop.
 * Hold-to-talk is the in-page listener's (components/useHotkeys.ts).
 */
export const REPEAT_GAP_MS = 650;

export function createCommandTalk(d: {
  start(): void;
  stop(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}) {
  let state: "idle" | "pressed" | "listening" = "idle";
  let repeats = 0;
  let timer: unknown = null;

  const settle = () => {
    timer = null;
    if (state !== "pressed") return;
    // Held (it repeated): let go now, so send. A single tap: keep listening until the next tap.
    if (repeats > 0) {
      state = "idle";
      d.stop();
    } else state = "listening";
  };

  return {
    get state() {
      return state;
    },
    /** One "talk" command event. */
    press() {
      if (state === "idle") {
        state = "pressed";
        repeats = 0;
        d.start();
      } else if (state === "pressed") {
        repeats++;
        if (timer !== null) d.clearTimer(timer);
      } else {
        state = "idle";
        return d.stop();
      }
      timer = d.setTimer(settle, REPEAT_GAP_MS);
    },
    /** Listening ended some other way (Escape, a new command): forget the press. */
    reset() {
      if (timer !== null) d.clearTimer(timer);
      timer = null;
      state = "idle";
    },
  };
}
