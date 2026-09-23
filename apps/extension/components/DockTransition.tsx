/**
 * Floating <-> docked, as one movement. The side panel is browser chrome and can't be animated, so the page animates
 * around it:
 *   dock    the orb stretches toward the window's edge (a strand reaching out, `spring.dockStretch`), then drains
 *           off-screen along it (`spring.dockDrain`). The side panel is requested as the drain begins (onPanelCue), so it
 *           appears just as the liquid leaves the screen.
 *   undock  as the side panel closes, a droplet emerges from that edge trailing a strand (`spring.undockTravel`, one
 *           small overshoot), travels to the orb's saved position, and reforms into the orb (`spring.undockReform`).
 * Chrome opens its side panel on the right by default, and a page can't ask which side it is on, so the liquid uses
 * the right edge. Two empty shapes are filtered (a droplet and a strand, liquid-gooey); nothing with text is.
 * Under prefers-reduced-motion there is no liquid: the orb simply fades (the caller's .g-orb-button.is-hidden).
 */
import { Liquid } from "liquid-gooey";
import { useEffect, useLayoutEffect, useRef } from "react";

import { prefersReducedMotion } from "../lib/motionBudget";
import { runSpring, type SpringConfig, type SpringRun } from "../lib/spring";
import { goo, spring } from "../lib/tokens";
import type { Box } from "./GooPanel";

/** The liquid at one instant: the droplet's centre and size, and the strand's two ends (all along x). */
export interface DockShape {
  cx: number;
  size: number;
  strandFrom: number;
  strandTo: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixShape = (a: DockShape, b: DockShape, t: number): DockShape => ({
  cx: lerp(a.cx, b.cx, t),
  size: Math.max(0, lerp(a.size, b.size, t)),
  strandFrom: lerp(a.strandFrom, b.strandFrom, t),
  strandTo: lerp(a.strandTo, b.strandTo, t),
});

/** The keyframes of each movement, in viewport x. `edge` is where the liquid leaves (or enters): past the right edge. */
export function dockLegs(kind: "dock" | "undock", orb: Box, vw: number): Array<{ to: DockShape; cfg: SpringConfig; cue?: true }> {
  const cx = orb.left + orb.width / 2;
  const size = orb.width;
  const neck = goo.dockNeck;
  const edge = vw + size; // fully off-screen
  if (kind === "dock") {
    return [
      // A strand reaches from the orb to the edge; the orb swells a little as it starts to pour.
      { to: { cx, size: size * 1.08, strandFrom: cx, strandTo: edge }, cfg: spring.dockStretch },
      // It drains along the strand and off the screen, thinning to the neck. The side panel is cued as it starts.
      { to: { cx: edge + size, size: neck, strandFrom: edge + size, strandTo: edge + size }, cfg: spring.dockDrain, cue: true },
    ];
  }
  return [
    // A droplet travels in from the edge, trailing a strand back to it, and grows as it goes.
    { to: { cx, size, strandFrom: cx, strandTo: edge }, cfg: spring.undockTravel },
    // The strand is drawn back into the droplet, which settles into the orb.
    { to: { cx, size, strandFrom: cx, strandTo: cx }, cfg: spring.undockReform },
  ];
}

export function dockStart(kind: "dock" | "undock", orb: Box, vw: number): DockShape {
  const cx = orb.left + orb.width / 2;
  if (kind === "dock") return { cx, size: orb.width, strandFrom: cx, strandTo: cx };
  const edge = vw + orb.width;
  return { cx: edge, size: goo.dockNeck, strandFrom: edge, strandTo: edge };
}

interface Props {
  kind: "dock" | "undock";
  /** The orb's disc, in viewport pixels (its saved position when undocking). */
  orb: Box;
  /** Dock only: the moment to open the side panel (the liquid starts leaving the screen). */
  onPanelCue?(): void;
  onDone(): void;
}

export function DockTransition({ kind, orb, onPanelCue, onDone }: Props) {
  const reduced = prefersReducedMotion();
  const vw = window.innerWidth;
  const drop = useRef<HTMLDivElement>(null);
  const strand = useRef<HTMLDivElement>(null);
  const cbs = useRef({ onPanelCue, onDone });
  cbs.current = { onPanelCue, onDone };

  // The stage: a band from just left of the orb to past the right edge, the orb's height plus room for the goo.
  const pad = 40;
  const left = orb.left - pad;
  const top = orb.top - pad;
  const width = vw + orb.width * 3 - left;
  const height = orb.height + pad * 2;
  const cy = orb.top + orb.height / 2 - top;

  const paint = (s: DockShape) => {
    const d = drop.current;
    if (d) {
      d.style.left = `${s.cx - s.size / 2 - left}px`;
      d.style.top = `${cy - s.size / 2}px`;
      d.style.width = `${s.size}px`;
      d.style.height = `${s.size}px`;
    }
    const st = strand.current;
    if (st) {
      const from = Math.min(s.strandFrom, s.strandTo);
      const len = Math.abs(s.strandTo - s.strandFrom);
      st.style.left = `${from - left}px`;
      st.style.top = `${cy - goo.dockNeck / 2}px`;
      st.style.width = `${len}px`;
      st.style.height = `${len > 0 ? goo.dockNeck : 0}px`;
    }
  };

  useLayoutEffect(() => {
    if (!reduced) paint(dockStart(kind, orb, vw));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (reduced) {
      // A plain fade, handled by the caller's orb button; the panel is requested at once.
      if (kind === "dock") cbs.current.onPanelCue?.();
      const t = setTimeout(() => cbs.current.onDone(), 120);
      return () => clearTimeout(t);
    }
    const legs = dockLegs(kind, orb, vw);
    let shape = dockStart(kind, orb, vw);
    let run: SpringRun | null = null;
    let cancelled = false;
    const leg = (i: number) => {
      if (cancelled) return;
      if (i >= legs.length) return cbs.current.onDone();
      const { to, cfg, cue } = legs[i]!;
      if (cue) cbs.current.onPanelCue?.();
      const from = shape;
      run = runSpring(
        0,
        1,
        cfg,
        (t) => {
          shape = mixShape(from, to, t);
          paint(shape);
        },
        () => leg(i + 1),
        // Hand over to the next leg while still moving, so dock and undock read as one movement.
        { settleDistance: i < legs.length - 1 ? spring.settle.handoff : spring.settle.distance },
      );
    };
    leg(0);
    return () => {
      cancelled = true;
      run?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (reduced) return null;
  return (
    <div className="g-goo-stage" style={{ left, top, width, height }} aria-hidden data-dock={kind}>
      <Liquid blur={goo.blurLite} contrast={18} fill="var(--g-canvas)" filterPadding={16} style={{ width: "100%", height: "100%" }}>
        <Liquid.Item observe>
          <div ref={strand} className="g-goo-blob g-dock-strand" />
        </Liquid.Item>
        <Liquid.Item observe>
          <div ref={drop} className="g-goo-blob g-dock-drop" style={{ borderRadius: "50%" }} />
        </Liquid.Item>
      </Liquid>
    </div>
  );
}
