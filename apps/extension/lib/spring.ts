/**
 * A damped spring, parameterised the way designers tune them: `response` (seconds per natural oscillation) and
 * `damping` (ratio; 1 is critically damped). Values live in lib/tokens.ts `spring`.
 * It carries velocity, so a spring started mid-motion (or from a fast drag) reacts to that speed and distance.
 */
import { spring as tokens } from "./tokens";

export interface SpringConfig {
  response: number;
  damping: number;
}

export interface SpringState {
  value: number;
  velocity: number;
}

const STEP = 1 / 240; // fixed substeps keep the physics identical at 30, 60 or 120fps

/** Advances the spring towards `target` by `dt` seconds (semi-implicit Euler in fixed substeps). */
export function stepSpring(s: SpringState, target: number, cfg: SpringConfig, dt: number): void {
  const omega = (2 * Math.PI) / cfg.response;
  const k = omega * omega;
  const c = 2 * cfg.damping * omega;
  let left = Math.min(dt, 0.064); // after a stall (tab switch), don't integrate a huge jump
  while (left > 0) {
    const h = Math.min(STEP, left);
    const a = -k * (s.value - target) - c * s.velocity;
    s.velocity += a * h;
    s.value += s.velocity * h;
    left -= h;
  }
}

/** Settled: within `settle.distance` of the travel (or of 1 for zero-travel springs) and nearly still. */
export function isSettled(s: SpringState, target: number, travel: number): boolean {
  const scale = Math.max(Math.abs(travel), 1e-3);
  return Math.abs(s.value - target) / scale < tokens.settle.distance && Math.abs(s.velocity) / scale < tokens.settle.speed;
}

/** The peak overshoot for a damping ratio, as a fraction of the travel. 0 when critically damped or over. */
export function overshootFor(damping: number): number {
  if (damping >= 1) return 0;
  return Math.exp((-damping * Math.PI) / Math.sqrt(1 - damping * damping));
}

export interface SpringRun {
  cancel(): void;
}

/**
 * Runs one spring from `from` to `to` on animation frames, calling `onFrame` with each value, then `onDone` once
 * settled (within `spring.settle`), or after `maxMs` so a spring can never outlast the shape it drives.
 */
export function runSpring(
  from: number,
  to: number,
  cfg: SpringConfig,
  onFrame: (value: number) => void,
  onDone?: () => void,
  opts: { velocity?: number; maxMs?: number; snap?: boolean } = {},
): SpringRun {
  const s: SpringState = { value: from, velocity: opts.velocity ?? 0 };
  const maxMs = opts.maxMs ?? tokens.maxMs;
  let last = performance.now();
  const start = last;
  let raf = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    // Snap the last hair to the target, unless the next motion carries on from here (no visible jump between legs).
    if (opts.snap !== false) onFrame(to);
    onDone?.();
  };
  const tick = (now: number) => {
    stepSpring(s, to, cfg, Math.max(0, (now - last) / 1000));
    last = now;
    if (isSettled(s, to, to - from || 1) || now - start >= maxMs) return finish();
    onFrame(s.value);
    raf = requestAnimationFrame(tick);
  };
  if (from === to && !opts.velocity) {
    queueMicrotask(finish);
  } else {
    raf = requestAnimationFrame(tick);
  }
  return {
    cancel: () => {
      done = true;
      cancelAnimationFrame(raf);
    },
  };
}
