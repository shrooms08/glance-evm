/**
 * Physical motion for the orb, on springs from lib/tokens.ts `spring`:
 *   follow()   while dragging, the orb trails the cursor slightly (critically damped, never passes it);
 *   release()  one jiggle on release, scaled by how fast it was thrown;
 *   blocked    a short horizontal shake, once, when a trade is refused;
 *   breathing  a very slow pulse while idle (CSS, on the inner disc), dropped first on slow pages.
 * Only the orb moves: never text, the confirm card or hover cards. Under prefers-reduced-motion nothing here runs.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { idlePulseAllowed, prefersReducedMotion, subscribeMotion } from "../lib/motionBudget";
import { isSettled, stepSpring, type SpringConfig, type SpringState } from "../lib/spring";
import { spring } from "../lib/tokens";
import type { OrbState } from "./Orb";

interface Channel extends SpringState {
  target: number;
  cfg: SpringConfig;
  travel: number;
  since: number;
}

type Name = "x" | "y" | "scale" | "shake";

export interface OrbMotion {
  /** The orb's anchor moved by (dx, dy) screen pixels under the cursor: lag behind it. */
  follow(dx: number, dy: number): void;
  /** Dropped after a drag moving at `speed` px/s. */
  release(speed: number): void;
  /** Whether the idle breathing pulse should run now (set it as data-breathe on the element). */
  breathe: boolean;
}

export function useOrbMotion(el: RefObject<HTMLElement | null>, state: OrbState, opts: { still?: boolean; dragging?: boolean } = {}): OrbMotion {
  const reduced = prefersReducedMotion();
  const channels = useRef<Record<Name, Channel>>({
    x: { value: 0, velocity: 0, target: 0, cfg: spring.dragFollow, travel: 1, since: 0 },
    y: { value: 0, velocity: 0, target: 0, cfg: spring.dragFollow, travel: 1, since: 0 },
    scale: { value: 1, velocity: 0, target: 1, cfg: spring.dragRelease, travel: 1, since: 0 },
    shake: { value: 0, velocity: 0, target: 0, cfg: spring.blockedShake, travel: 1, since: 0 },
  });
  const raf = useRef(0);
  const last = useRef(0);

  const write = useCallback(() => {
    const c = channels.current;
    const node = el.current;
    if (!node) return;
    const x = c.x.value + c.shake.value;
    const y = c.y.value;
    const s = c.scale.value;
    node.style.transform = Math.abs(x) < 0.05 && Math.abs(y) < 0.05 && Math.abs(s - 1) < 0.0005 ? "" : `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${s.toFixed(4)})`;
  }, [el]);

  const loop = useCallback(
    (now: number) => {
      const dt = last.current ? (now - last.current) / 1000 : 1 / 60;
      last.current = now;
      let active = false;
      for (const ch of Object.values(channels.current)) {
        if (ch.value === ch.target && ch.velocity === 0) continue;
        stepSpring(ch, ch.target, ch.cfg, dt);
        // A spring never outlasts its cap: past it, it snaps home.
        if (isSettled(ch, ch.target, ch.travel) || now - ch.since > spring.maxMs) {
          ch.value = ch.target;
          ch.velocity = 0;
        } else {
          active = true;
        }
      }
      write();
      raf.current = active ? requestAnimationFrame(loop) : 0;
      if (!active) last.current = 0;
    },
    [write],
  );

  const kick = useCallback(
    (name: Name, value: number, cfg: SpringConfig, travel: number) => {
      if (reduced) return;
      const ch = channels.current[name];
      ch.value = value;
      ch.cfg = cfg;
      ch.travel = travel;
      ch.since = performance.now();
      if (!raf.current) raf.current = requestAnimationFrame(loop);
    },
    [loop, reduced],
  );

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const follow = useCallback(
    (dx: number, dy: number) => {
      if (reduced) return;
      const c = channels.current;
      // Keep the orb where it was on screen, then let the spring pull it onto its new anchor.
      kick("x", c.x.value - dx, spring.dragFollow, Math.max(1, Math.abs(c.x.value - dx)));
      kick("y", c.y.value - dy, spring.dragFollow, Math.max(1, Math.abs(c.y.value - dy)));
    },
    [kick, reduced],
  );

  const release = useCallback(
    (speed: number) => {
      const amount = Math.min(spring.dragRelease.maxKick, speed * spring.dragRelease.perSpeed);
      if (amount > 0.002) kick("scale", 1 - amount, spring.dragRelease, amount);
    },
    [kick],
  );


  // Blocked: shake once, on the way into the state.
  const prev = useRef(state);
  useEffect(() => {
    if (state === "blocked" && prev.current !== "blocked") kick("shake", -spring.blockedShake.kick, spring.blockedShake, spring.blockedShake.kick);
    prev.current = state;
  }, [state, kick]);

  // Breathing: only idle, only when nothing is pending, and only while the page can afford it.
  const [budget, setBudget] = useState(idlePulseAllowed());
  useEffect(() => subscribeMotion(() => setBudget(idlePulseAllowed())), []);
  const breathe = !reduced && budget && state === "idle" && !opts.still && !opts.dragging;

  return { follow, release, breathe };
}
