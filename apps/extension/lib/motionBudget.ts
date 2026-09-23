/**
 * The page's motion budget. Busy pages (CNBC's ads and video) can't always hold frame rate; when frames run long we
 * give up motion in this order: first the idle breathing pulse, then the goo filter's quality. Animations that carry
 * meaning (open, close, blocked) keep running, just cheaper.
 */

export type MotionLevel = 0 | 1 | 2; // 0 everything, 1 no idle pulse, 2 also lite goo

let level: MotionLevel = 0;
let strikes = 0;
const listeners = new Set<() => void>();

/** Frame budget: a mean frame over 22ms, or more than a quarter of frames over 34ms, means we are dropping frames. */
export function tooSlow(deltas: number[]): boolean {
  if (deltas.length < 4) return false;
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const long = deltas.filter((d) => d > 34).length / deltas.length;
  return mean > 22 || long > 0.25;
}

function set(next: MotionLevel) {
  if (next <= level) return;
  level = next;
  listeners.forEach((l) => l());
}

/**
 * Frames measured during a motion. One slow report drops the idle pulse; two in a row also lower the goo quality.
 * A single hiccup is common on busy pages, so the goo needs two.
 */
export function reportFrames(deltas: number[]): void {
  if (!tooSlow(deltas)) {
    strikes = 0;
    return;
  }
  strikes++;
  set(strikes >= 2 ? 2 : 1);
}

/** A quiet-time sample (no motion of ours running): it can only cost the idle pulse. */
export function reportIdleFrames(deltas: number[]): void {
  if (tooSlow(deltas)) set(1);
}

export const motionLevel = () => level;
export const idlePulseAllowed = () => level < 1;
export const gooQuality = (): "full" | "lite" => (level >= 2 ? "lite" : "full");

export function subscribeMotion(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Records `count` frame intervals. */
export function sampleFrames(count = 45): Promise<number[]> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = 0;
    const tick = (now: number) => {
      if (last) deltas.push(now - last);
      last = now;
      if (deltas.length >= count) resolve(deltas);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** For tests only. */
export function resetMotionBudgetForTests(): void {
  level = 0;
  strikes = 0;
}
