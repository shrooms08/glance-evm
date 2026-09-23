/**
 * Beat 2 of floating <-> docked: the liquid between the orb and the window edge. (Beat 1 is the floating panel
 * draining into the orb, GooPanel's close; beat 3 is the browser's side panel opening or closing.)
 *
 * Driven by liquid-gooey: the orb and two trailing droplets (lib/tokens.ts `liquid.dockTrail`) are <Liquid.Item>s in
 * one <Liquid> container, moved by the library's own transition with the overshoot curve and a stagger. Because each
 * piece leaves (or arrives) a stagger after the one before, the goo filter draws them as one mass stretching out.
 *   dock    the orb leads off toward the right edge, the droplets follow, and the whole mass pours off-screen. The
 *           side panel is requested `panelLeadMs` before the last droplet leaves, so it appears as the liquid goes.
 *   undock  the droplets come in from the edge, the orb-sized lead arrives last and overshoots into place: the orb
 *           reforms at its saved position. Only then does the real orb reappear (onDone).
 * Chrome opens its side panel on the right by default, and a page can't ask which side it is on, so the liquid uses
 * the right edge. Nothing with text is ever inside an item. Under prefers-reduced-motion: a plain fade.
 */
import { Liquid } from "liquid-gooey";
import { createRef, useEffect, useRef, useState, type RefObject } from "react";

import { prefersReducedMotion } from "../lib/motionBudget";
import { liquid, motion } from "../lib/tokens";
import type { Box } from "./GooPanel";
import { liquidTransition, useLiquidSettled, type Pose } from "./liquid";

const FADE_MS = parseFloat(motion.quick);

/** The orb and its trailing droplets: sizes (px), the pose for each end of the movement, and each one's delay. */
export function dockPieces(kind: "dock" | "undock", orb: Box, vw: number) {
  const sizes = [orb.width, ...liquid.dockTrail.map((f) => orb.width * f)];
  const cx = orb.left + orb.width / 2;
  // Far enough right that even the overshoot stays off-screen.
  const off = vw - cx + orb.width * 1.5;
  return sizes.map((size, i) => {
    const home: Pose = { x: 0, y: 0, scale: 1 };
    const away: Pose = { x: off, y: 0, scale: 0.7 };
    // Dock: the orb leads and the droplets follow. Undock: the droplets arrive first and the orb-sized lead last.
    const delay = kind === "dock" ? i * liquid.stagger : (sizes.length - 1 - i) * liquid.stagger;
    return { size, delay, from: kind === "dock" ? home : away, to: kind === "dock" ? away : home };
  });
}

/** When to ask for the side panel during a dock: just before the last piece leaves the screen. */
export function panelCueMs() {
  const lastDelay = liquid.dockTrail.length * liquid.stagger;
  return Math.max(0, lastDelay + liquid.duration - liquid.panelLeadMs);
}

interface Props {
  kind: "dock" | "undock";
  /** The orb's disc, in viewport pixels (its saved position when undocking). */
  orb: Box;
  /** Dock only: the moment to open the side panel (the liquid is leaving the screen). */
  onPanelCue?(): void;
  onDone(): void;
}

export function DockTransition({ kind, orb, onPanelCue, onDone }: Props) {
  const reduced = prefersReducedMotion();
  const vw = window.innerWidth;
  const pieces = dockPieces(kind, orb, vw);
  const [moving, setMoving] = useState(false);
  const refs = useRef<Array<RefObject<HTMLDivElement>>>(pieces.map(() => createRef<HTMLDivElement>())).current;
  const cbs = useRef({ onPanelCue, onDone });
  cbs.current = { onPanelCue, onDone };

  // Mount on the starting pose, then let the library move everything to the end pose.
  useEffect(() => {
    if (reduced) {
      if (kind === "dock") cbs.current.onPanelCue?.();
      const t = setTimeout(() => cbs.current.onDone(), FADE_MS);
      return () => clearTimeout(t);
    }
    let raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => setMoving(true))));
    const cue = kind === "dock" ? setTimeout(() => cbs.current.onPanelCue?.(), panelCueMs() + 32) : undefined;
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(cue);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLiquidSettled(
    moving && !reduced ? kind : null,
    pieces.map((p, i) => ({ ref: refs[i]!, pose: p.to, delay: p.delay })),
    () => cbs.current.onDone(),
  );

  if (reduced) return null;

  // The stage: a band from just left of the orb to past the right edge, the orb's height plus room for the goo.
  const pad = 40;
  const left = orb.left - pad;
  const top = orb.top - pad;
  const width = vw + orb.width * 3 - left;
  const height = orb.height + pad * 2;
  const cy = orb.top + orb.height / 2;
  const cx = orb.left + orb.width / 2;
  return (
    <div className="g-goo-stage" style={{ left, top, width, height }} aria-hidden data-dock={kind}>
      <Liquid blur={liquid.blur} contrast={liquid.contrast} fill="var(--g-canvas)" style={{ width: "100%", height: "100%" }}>
        {pieces.map((p, i) => (
          <Liquid.Item
            key={i}
            style={{ position: "absolute", left: cx - p.size / 2 - left, top: cy - p.size / 2 - top }}
            {...(moving ? p.to : p.from)}
            transition={liquidTransition}
            delay={p.delay}
          >
            <div ref={refs[i]} className="g-goo-blob g-dock-drop" style={{ width: p.size, height: p.size, borderRadius: "50%" }} />
          </Liquid.Item>
        ))}
      </Liquid>
    </div>
  );
}
