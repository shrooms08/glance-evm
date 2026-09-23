/**
 * Shared plumbing for the liquid-gooey choreography (GooPanel, DockTransition).
 *
 * liquid-gooey moves each <Liquid.Item> with its own transition (`x`, `y`, `scale`, `transition`, `delay`), writing
 * the transform to the item's wrapper and to its blob in the filtered silhouette on every frame. It exposes no
 * completion callback, so we watch the wrappers: an item has settled when its wrapper's transform has reached the pose
 * we gave it. That completion, not a fixed timer, is what lets text in.
 */
import { useEffect, useRef, type RefObject } from "react";

import { liquid } from "../lib/tokens";

export interface Pose {
  x: number;
  y: number;
  scale: number;
}

/** The library's transition for every liquid item: our duration and overshoot curve (lib/tokens.ts `liquid`). */
export const liquidTransition = { duration: liquid.duration, ease: liquid.ease };

/** Reads liquid-gooey's "translate(Xpx, Ypx) scale(S)" back into numbers. */
export function readPose(transform: string): Pose | null {
  const t = /translate\((-?[\d.e-]+)px,\s*(-?[\d.e-]+)px\)/.exec(transform);
  if (!t) return null;
  const s = /scale\((-?[\d.e-]+)\)/.exec(transform);
  return { x: Number(t[1]), y: Number(t[2]), scale: s ? Number(s[1]) : 1 };
}

/** Reached means the library's final frame: it lands exactly on the pose, so text never sees even a sub-pixel creep. */
export const poseReached = (at: Pose | null, want: Pose) =>
  at !== null && Math.abs(at.x - want.x) < 0.05 && Math.abs(at.y - want.y) < 0.05 && Math.abs(at.scale - want.scale) < 0.0005;

/**
 * Calls `onSettled` once every item (identified by a ref to the element we put inside it) has reached its pose, after
 * the given `key` changes. A deadline of the longest delay plus the duration plus slack guarantees it fires even if a
 * frame is missed, so text can never be left hidden.
 */
export function useLiquidSettled(
  key: string | null,
  items: Array<{ ref: RefObject<HTMLElement | null>; pose: Pose; delay: number }>,
  onSettled: () => void,
) {
  const latest = useRef({ items, onSettled });
  latest.current = { items, onSettled };
  useEffect(() => {
    if (key === null) return;
    let raf = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(deadline);
      latest.current.onSettled();
    };
    // Don't read the very first frames: the item hasn't started moving yet and still sits on its previous pose.
    const started = performance.now();
    const check = () => {
      const all = latest.current.items;
      const settled =
        performance.now() - started > 32 &&
        all.every(({ ref, pose }) => poseReached(readPose(ref.current?.parentElement?.style.transform ?? ""), pose));
      if (settled) return finish();
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    const longest = Math.max(0, ...items.map((i) => i.delay)) + liquid.duration + 250;
    const deadline = setTimeout(finish, longest);
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(deadline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
