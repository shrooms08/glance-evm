/**
 * The floating panel's open and close: the orb melts open into the panel, and the panel collapses back into it.
 *
 * Built on liquid-gooey. Only two plain, empty shapes are filtered: a disc under the orb and a box that grows from
 * the orb to the panel's footprint. The goo filter merges them into one liquid surface. The real panel (text, prices,
 * cards, buttons) is never inside a filtered layer: it sits on top, unfiltered, and fades in once the liquid has
 * taken its shape (and out before it collapses). The filter's SVG is rendered by <Liquid> right here, inside our
 * shadow root, so its url(#id) reference resolves.
 *
 * The liquid stage exists only while moving; at rest the panel is an ordinary card and the filter costs nothing.
 * Timings come from the design tokens (motion.panel for the shape, motion.quick for the content fade). Under
 * prefers-reduced-motion there is no goo: the panel scales and fades. If a page is too heavy to hold frame rate, the
 * filter quality drops (a smaller blur, no shadow) rather than the animation.
 */
import { Liquid } from "liquid-gooey";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { color, motion, orb as orbTokens } from "../lib/tokens";

const SHAPE_MS = parseFloat(motion.panel); // 180ms: the liquid's travel
const FADE_MS = parseFloat(motion.quick); // 120ms: the content's fade
/** A frame or two of slack after the last transition before the liquid stage is removed. */
const SETTLE_MS = 40;

export type GooQuality = "full" | "lite";

/**
 * Per page: once a page proves too heavy for full quality, it stays lite. Busy pages (CNBC's ads and video) hiccup on
 * their own, so one slow open is not enough; two in a row is.
 */
let quality: GooQuality = "full";
let slowOpens = 0;
export const gooQuality = () => quality;

/** Frame budget: a mean frame over 22ms, or more than a quarter of frames over 34ms, means we are dropping frames. */
export function tooSlow(deltas: number[]): boolean {
  if (deltas.length < 4) return false;
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const long = deltas.filter((d) => d > 34).length / deltas.length;
  return mean > 22 || long > 0.25;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Phase = "closed" | "opening" | "open" | "closing";
/**
 * The liquid's path. Opening: orb -> stretch (one piece from the orb up to the panel's far edge) -> panel (the edge
 * nearest the orb pulls away, and the neck to the orb stretches and pinches off). Closing runs the same path back.
 */
type Target = "orb" | "stretch" | "panel";
interface Box {
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
  children?: ReactNode;
}

export function GooPanel({ open, orb, placement, children }: Props) {
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");
  /** The liquid box's target: the orb's disc, one piece spanning orb and panel, or the panel's footprint. */
  const [target, setTarget] = useState<Target>("orb");
  const [contentShown, setContentShown] = useState(open);
  const [panelBox, setPanelBox] = useState<Box | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const reduced = prefersReducedMotion();
  const frames = useRef<number[]>([]);
  const frameLoop = useRef(0);

  // Drive the phases from `open`.
  useEffect(() => {
    if (open && (phase === "closed" || phase === "closing")) {
      setPhase("opening");
      setTarget("orb");
      setContentShown(false);
    } else if (!open && (phase === "open" || phase === "opening")) {
      setPhase("closing");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Measure the panel's footprint whenever the liquid needs it.
  useLayoutEffect(() => {
    if ((phase === "opening" || phase === "closing") && panelRef.current) {
      const r = panelRef.current.getBoundingClientRect();
      setPanelBox({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
  }, [phase]);

  // The timeline for each phase.
  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
    let raf = 0;
    if (phase === "opening") {
      if (reduced) {
        raf = requestAnimationFrame(() => setContentShown(true));
        at(FADE_MS, () => setPhase("open"));
      } else {
        startFrames();
        // Two frames: the liquid first paints on the orb, then swells out of it into one piece over the panel's area.
        raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => setTarget("stretch"))));
        // Then it lets go of the orb, and the content fades in as the neck pinches off.
        at(SHAPE_MS, () => {
          setTarget("panel");
          setContentShown(true);
        });
        at(SHAPE_MS + FADE_MS + SETTLE_MS, () => {
          stopFrames();
          setPhase("open");
        });
      }
    } else if (phase === "closing") {
      setContentShown(false);
      if (reduced) {
        at(FADE_MS, () => setPhase("closed"));
      } else {
        startFrames();
        setTarget("panel");
        // The content fades first; the liquid reaches back down to the orb, then drains into it.
        at(FADE_MS, () => setTarget("stretch"));
        at(FADE_MS * 2, () => setTarget("orb"));
        at(FADE_MS * 2 + SHAPE_MS + SETTLE_MS, () => {
          stopFrames();
          setPhase("closed");
        });
      }
    }
    return () => {
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
      cancelAnimationFrame(frameLoop.current);
    };

    function startFrames() {
      frames.current = [];
      let last = 0;
      const tick = (now: number) => {
        if (last) frames.current.push(now - last);
        last = now;
        frameLoop.current = requestAnimationFrame(tick);
      };
      cancelAnimationFrame(frameLoop.current);
      frameLoop.current = requestAnimationFrame(tick);
    }
    function stopFrames() {
      cancelAnimationFrame(frameLoop.current);
      // The first frames carry React mounting the panel, which isn't the filter's cost: judge the liquid's motion.
      const deltas = frames.current.slice(2);
      slowOpens = tooSlow(deltas) ? slowOpens + 1 : 0;
      if (slowOpens >= 2) quality = "lite";
      if (panelRef.current) {
        const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
        panelRef.current.dataset.gooFrames = `${deltas.length} frames, mean ${mean.toFixed(1)}ms, max ${Math.max(0, ...deltas).toFixed(1)}ms`;
        panelRef.current.dataset.gooQuality = quality;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (phase === "closed") return null;

  const moving = phase === "opening" || phase === "closing";
  const showStage = moving && !reduced && panelBox !== null;
  const q = quality;

  const panelClass = ["g-panel", reduced ? "g-panel-reduced" : "g-panel-goo", contentShown ? "is-shown" : ""].filter(Boolean).join(" ");

  return (
    <>
      {showStage && panelBox && <GooStage orb={orb} panel={panelBox} target={target} quality={q} />}
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

function GooStage({ orb, panel, target, quality: q }: { orb: Box; panel: Box; target: Target; quality: GooQuality }) {
  // A tight stage around the orb and the panel: the filter's cost scales with its area, never the whole viewport.
  const left = Math.min(orb.left, panel.left);
  const top = Math.min(orb.top, panel.top);
  const width = Math.max(orb.left + orb.width, panel.left + panel.width) - left;
  const height = Math.max(orb.top + orb.height, panel.top + panel.height) - top;
  const rel = (b: Box) => ({ left: b.left - left, top: b.top - top, width: b.width, height: b.height });
  const to =
    target === "orb"
      ? { ...rel(orb), borderRadius: "50%" }
      : target === "panel"
        ? { ...rel(panel), borderRadius: "var(--g-r-card)" }
        : { ...rel(stretch(orb, panel)), borderRadius: "var(--g-r-card)" };

  return (
    <div className="g-goo-stage" style={{ left, top, width, height }} aria-hidden data-goo-quality={q}>
      <Liquid
        blur={q === "full" ? 12 : 7}
        contrast={18}
        fill="var(--g-surface)"
        shadow={q === "full" ? `0 12px 32px ${color.shadow}` : undefined}
        filterPadding={16}
        style={{ width: "100%", height: "100%" }}
      >
        <Liquid.Item observe>
          <div className="g-goo-blob" style={{ ...rel(orb), borderRadius: "50%" }} />
        </Liquid.Item>
        {/* No spring physics: the liquid follows the token-timed CSS transition exactly, so the panel's content never
            fades in over bare page. The melt itself comes from the goo filter joining this shape to the orb's. */}
        <Liquid.Item observe>
          <div className="g-goo-blob g-goo-morph" style={to} />
        </Liquid.Item>
      </Liquid>
    </div>
  );
}

/** One piece across the panel's width, from its far edge to the orb's far edge: the liquid while it is still attached. */
export function stretch(orb: Box, panel: Box): Box {
  const top = Math.min(orb.top, panel.top);
  const bottom = Math.max(orb.top + orb.height, panel.top + panel.height);
  const left = Math.min(panel.left, Math.max(orb.left, panel.left));
  const right = Math.max(panel.left + panel.width, Math.min(orb.left + orb.width, panel.left + panel.width));
  return { left, top, width: right - left, height: bottom - top };
}

/** The orb disc's viewport box, from the orb button's right/bottom offsets. */
export function orbDisc(pos: { right: number; bottom: number }, vw = window.innerWidth, vh = window.innerHeight): Box {
  const inset = (orbTokens.hitArea - orbTokens.floating) / 2;
  return { left: vw - pos.right - orbTokens.hitArea + inset, top: vh - pos.bottom - orbTokens.hitArea + inset, width: orbTokens.floating, height: orbTokens.floating };
}
