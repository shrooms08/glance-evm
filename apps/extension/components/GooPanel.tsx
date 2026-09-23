/**
 * The floating panel's open and close: the orb melts open into the panel, and the panel drains back into it.
 *
 * Driven by liquid-gooey the way it is meant to be used: the orb, a droplet and the panel's liquid are three
 * <Liquid.Item>s in one <Liquid> container, and the library's own transition moves them (`x`, `y`, `scale`, with the
 * overshoot curve and a stagger from lib/tokens.ts `liquid`). The goo filter merges them while they move, so the neck
 * between orb and panel, and the swell of the orb as it takes the liquid back, come from the library, not from us.
 *
 *   open   the droplet leads out of the orb toward the panel; one stagger later the panel's liquid grows out of the
 *          orb (from `seedScale`) to the panel's footprint, overshooting and settling on the curve.
 *   close  the same in reverse: the panel's liquid shrinks back into the orb first, the droplet follows, and the orb
 *          swells back last; the curve's overshoot is the orb's wobble as it absorbs the panel.
 *
 * The panel's content (text, prices, cards, buttons) is never inside an item or the filtered layer. It fades in only
 * once every item has reached its pose (read back from the library's transforms, not timed), and fades out before
 * the liquid moves. At rest the liquid is removed and the panel is an ordinary card of the same colour and shape.
 * Under prefers-reduced-motion there is no liquid: the panel scales and fades. On pages that can't hold frame rate
 * the filter's blur and shadow drop; the timing never changes.
 */
import { Liquid } from "liquid-gooey";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { gooQuality, prefersReducedMotion, reportFrames } from "../lib/motionBudget";
import { color, liquid, motion, orb as orbTokens, radius } from "../lib/tokens";
import { liquidTransition, useLiquidSettled, type Pose } from "./liquid";

export { tooSlow } from "../lib/motionBudget";
export { prefersReducedMotion };

const FADE_MS = parseFloat(motion.quick); // 120ms: the content's fade

type Phase = "closed" | "opening" | "open" | "closing";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Props {
  open: boolean;
  /** Where the orb's disc is, in viewport pixels. */
  orb: Box;
  /** The panel's fixed placement (left/right/top/bottom). */
  placement: CSSProperties;
  /** The panel has fully drained back into the orb (docking waits for this before its next beat). */
  onClosed?(): void;
  children?: ReactNode;
}

export function GooPanel({ open, orb, placement, onClosed, children }: Props) {
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");
  /** Where the liquid items are headed: gathered in the orb, or spread out as the panel. */
  const [pose, setPose] = useState<"orb" | "panel">("orb");
  const [contentShown, setContentShown] = useState(open);
  const [panelBox, setPanelBox] = useState<Box | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const reduced = prefersReducedMotion();
  const frames = useRef<number[]>([]);
  const frameLoop = useRef(0);
  const closed = useRef(onClosed);
  closed.current = onClosed;

  useEffect(() => {
    if (open && (phase === "closed" || phase === "closing")) {
      setPhase("opening");
      setPose("orb");
      setContentShown(false);
    } else if (!open && (phase === "open" || phase === "opening")) {
      setPhase("closing");
      setPose("panel");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLayoutEffect(() => {
    if ((phase === "opening" || phase === "closing") && panelRef.current) {
      const r = panelRef.current.getBoundingClientRect();
      setPanelBox({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
  }, [phase]);

  const startFrames = useCallback(() => {
    frames.current = [];
    let last = 0;
    const tick = (now: number) => {
      if (last) frames.current.push(now - last);
      last = now;
      frameLoop.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(frameLoop.current);
    frameLoop.current = requestAnimationFrame(tick);
  }, []);

  const stopFrames = useCallback(() => {
    cancelAnimationFrame(frameLoop.current);
    // The first frames carry React mounting the panel, which isn't the motion's cost.
    const deltas = frames.current.slice(2);
    reportFrames(deltas);
    if (panelRef.current) {
      const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
      panelRef.current.dataset.gooFrames = `${deltas.length} frames, mean ${mean.toFixed(1)}ms, max ${Math.max(0, ...deltas).toFixed(1)}ms`;
      panelRef.current.dataset.gooQuality = gooQuality();
    }
  }, []);

  // Phase entry. The liquid mounts on its starting pose, then the pose flips and the library moves it.
  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let raf = 0;
    if (phase === "opening") {
      if (reduced) {
        raf = requestAnimationFrame(() => setContentShown(true));
        timers.push(setTimeout(() => setPhase("open"), FADE_MS));
      } else {
        startFrames();
        raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => setPose("panel"))));
      }
    } else if (phase === "closing") {
      setContentShown(false);
      if (reduced) {
        timers.push(
          setTimeout(() => {
            setPhase("closed");
            closed.current?.();
          }, FADE_MS),
        );
      } else {
        startFrames();
        // The text fades out first; only then does the liquid move.
        timers.push(setTimeout(() => setPose("orb"), FADE_MS));
      }
    }
    return () => {
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
    };
  }, [phase, reduced, startFrames]);

  useEffect(() => () => cancelAnimationFrame(frameLoop.current), []);

  const onSettled = useCallback(() => {
    if (phase === "opening" && pose === "panel") {
      // Every item has reached its pose: the shape is still. Only now does any text appear.
      stopFrames();
      setContentShown(true);
      setTimeout(() => setPhase((p) => (p === "opening" ? "open" : p)), FADE_MS);
    } else if (phase === "closing" && pose === "orb") {
      stopFrames();
      setPhase("closed");
      closed.current?.();
    }
  }, [phase, pose, stopFrames]);

  if (phase === "closed") return null;

  const moving = phase === "opening" || phase === "closing";
  const showStage = moving && !reduced && panelBox !== null;
  const panelClass = ["g-panel", reduced ? "g-panel-reduced" : "g-panel-goo", contentShown ? "is-shown" : ""].filter(Boolean).join(" ");

  return (
    <>
      {showStage && panelBox && (
        <GooStage
          orb={orb}
          panel={panelBox}
          pose={pose}
          direction={phase === "opening" ? "open" : "close"}
          quality={gooQuality()}
          onSettled={onSettled}
        />
      )}
      <div
        ref={panelRef}
        className={panelClass}
        style={{ ...placement, transformOrigin: `${"left" in placement ? "left" : "right"} ${"top" in placement ? "top" : "bottom"}` }}
        data-phase={phase}
        aria-hidden={!contentShown || undefined}
      >
        {children}
      </div>
    </>
  );
}

type Poses = Record<"orb" | "panel", Pose>;

/** The poses of the three items, relative to where each is laid out (its resting place in the panel pose). */
export function panelPoses(orb: Box, panel: Box): { dropletSize: number; dropletRest: { x: number; y: number }; orb: Poses; droplet: Poses; panel: Poses } {
  const oc = { x: orb.left + orb.width / 2, y: orb.top + orb.height / 2 };
  const pc = { x: panel.left + panel.width / 2, y: panel.top + panel.height / 2 };
  // The droplet rests just inside the panel's edge nearest the orb, so the card covers it when the liquid goes.
  const below = panel.top > orb.top;
  const dropletSize = orb.width * liquid.droplet;
  const dropletRest = {
    x: Math.min(Math.max(oc.x, panel.left + dropletSize), panel.left + panel.width - dropletSize),
    y: below ? panel.top + dropletSize : panel.top + panel.height - dropletSize,
  };
  return {
    dropletSize,
    dropletRest,
    orb: { orb: { x: 0, y: 0, scale: 1 }, panel: { x: 0, y: 0, scale: 0.9 } },
    droplet: { orb: { x: oc.x - dropletRest.x, y: oc.y - dropletRest.y, scale: 1 }, panel: { x: 0, y: 0, scale: 1 } },
    panel: { orb: { x: oc.x - pc.x, y: oc.y - pc.y, scale: liquid.seedScale }, panel: { x: 0, y: 0, scale: 1 } },
  };
}

/**
 * Delays per item and direction: the mass arrives in sequence. Opening, the droplet leads and the panel follows;
 * closing, the panel leaves first, the droplet follows, and the orb swells back last.
 */
export function panelDelays(direction: "open" | "close") {
  const s = liquid.stagger;
  return direction === "open" ? { droplet: 0, panel: s, orb: 0 } : { panel: 0, droplet: s, orb: 2 * s };
}

function GooStage({
  orb,
  panel,
  pose,
  direction,
  quality: q,
  onSettled,
}: {
  orb: Box;
  panel: Box;
  pose: "orb" | "panel";
  direction: "open" | "close";
  quality: "full" | "lite";
  onSettled(): void;
}) {
  // A tight stage around the orb and the panel: the filter's cost scales with its area, never the whole viewport.
  const left = Math.min(orb.left, panel.left);
  const top = Math.min(orb.top, panel.top);
  const width = Math.max(orb.left + orb.width, panel.left + panel.width) - left;
  const height = Math.max(orb.top + orb.height, panel.top + panel.height) - top;
  const poses = panelPoses(orb, panel);
  const delays = panelDelays(direction);
  const orbRef = useRef<HTMLDivElement>(null);
  const dropletRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLiquidSettled(
    `${direction}:${pose}`,
    [
      { ref: orbRef, pose: poses.orb[pose], delay: delays.orb },
      { ref: dropletRef, pose: poses.droplet[pose], delay: delays.droplet },
      { ref: panelRef, pose: poses.panel[pose], delay: delays.panel },
    ],
    onSettled,
  );

  const at = (x: number, y: number): CSSProperties => ({ position: "absolute", left: x - left, top: y - top });
  return (
    <div className="g-goo-stage" style={{ left, top, width, height }} aria-hidden data-goo-quality={q}>
      <Liquid
        blur={q === "full" ? liquid.blur : liquid.blurLite}
        contrast={liquid.contrast}
        fill="var(--g-surface)"
        shadow={q === "full" ? `0 12px 32px ${color.shadow}` : undefined}
        style={{ width: "100%", height: "100%" }}
      >
        <Liquid.Item style={at(orb.left, orb.top)} {...poses.orb[pose]} transition={liquidTransition} delay={delays.orb}>
          <div ref={orbRef} className="g-goo-blob" style={{ width: orb.width, height: orb.height, borderRadius: "50%" }} />
        </Liquid.Item>
        <Liquid.Item
          style={at(poses.dropletRest.x - poses.dropletSize / 2, poses.dropletRest.y - poses.dropletSize / 2)}
          {...poses.droplet[pose]}
          transition={liquidTransition}
          delay={delays.droplet}
        >
          <div ref={dropletRef} className="g-goo-blob g-goo-droplet" style={{ width: poses.dropletSize, height: poses.dropletSize, borderRadius: "50%" }} />
        </Liquid.Item>
        <Liquid.Item style={at(panel.left, panel.top)} {...poses.panel[pose]} transition={liquidTransition} delay={delays.panel}>
          <div ref={panelRef} className="g-goo-blob g-goo-morph" style={{ width: panel.width, height: panel.height, borderRadius: radius.card }} />
        </Liquid.Item>
      </Liquid>
    </div>
  );
}

/** The orb disc's viewport box, from the orb button's right/bottom offsets. */
export function orbDisc(pos: { right: number; bottom: number }, vw = window.innerWidth, vh = window.innerHeight): Box {
  const inset = (orbTokens.hitArea - orbTokens.floating) / 2;
  return { left: vw - pos.right - orbTokens.hitArea + inset, top: vh - pos.bottom - orbTokens.hitArea + inset, width: orbTokens.floating, height: orbTokens.floating };
}
