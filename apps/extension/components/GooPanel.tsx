/**
 * The floating panel's open and close: the orb melts open into the panel, and the panel collapses back into it.
 *
 * Built on liquid-gooey. Only two plain, empty shapes are filtered: a disc under the orb and a box that grows from
 * the orb to the panel's footprint. The goo filter merges them into one liquid surface. The real panel (text, prices,
 * cards, buttons) is never inside a filtered layer: it sits on top, unfiltered, and fades in once the liquid has
 * taken its shape (and out before it collapses). The filter's SVG is rendered by <Liquid> right here, inside our
 * shadow root, so its url(#id) reference resolves.
 *
 * Three empty shapes are filtered: the orb's disc, the liquid box, and a neck (a strand from the orb to the panel's
 * near edge). They move on springs (lib/tokens.ts `spring`), not easing curves:
 *   open   orb -> stretch on `panelOpen`: the box overshoots the panel's size once, while no text is showing;
 *          stretch -> panel on `panelSettle`: the panel lets go of the orb, no bounce, while the neck thins on its
 *          own slower `panelNeck` spring, so one substance visibly stretches and snaps. Text fades in once the box
 *          has settled (the neck is outside the panel), so text never sits on moving liquid;
 *   close  text fades out; panel -> stretch (the neck thickens) -> orb on `panelClose`; then the orb wobbles as it
 *          absorbs the panel (onAbsorbed).
 * Each spring is capped at `spring.maxMs`: if it would outlast the shape, it snaps, so the goo always wins.
 *
 * The liquid stage exists only while moving; at rest the panel is an ordinary card and the filter costs nothing.
 * Under prefers-reduced-motion there is no goo and no spring: the panel fades. If a page is too heavy to hold frame
 * rate, the idle pulse goes first, then the filter's blur and shadow (lib/motionBudget.ts). The timing never changes:
 * smooth motion matters more than filter fidelity.
 */
import { Liquid } from "liquid-gooey";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { gooQuality, prefersReducedMotion, reportFrames } from "../lib/motionBudget";
import { runSpring, type SpringConfig, type SpringRun } from "../lib/spring";
import { color, goo, motion, orb as orbTokens, radius, spring } from "../lib/tokens";

export { tooSlow } from "../lib/motionBudget";
export { prefersReducedMotion };

const FADE_MS = parseFloat(motion.quick); // 120ms: the content's fade

type Phase = "closed" | "opening" | "open" | "closing";
/**
 * The liquid's path. Opening: orb -> stretch (one piece from the orb up to the panel's far edge) -> panel (the edge
 * nearest the orb pulls away, and the neck to the orb stretches and pinches off). Closing runs the same path back.
 */
type Target = "orb" | "stretch" | "panel";

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
  /** The panel has fully drained into the orb (the orb's cue to wobble). */
  onAbsorbed?(): void;
  /** Close at once, without the liquid (the orb is about to dock and drain away instead). */
  skipClose?: boolean;
  children?: ReactNode;
}

export function GooPanel({ open, orb, placement, onAbsorbed, skipClose, children }: Props) {
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");
  const [target, setTarget] = useState<Target>("orb");
  const [contentShown, setContentShown] = useState(open);
  const [panelBox, setPanelBox] = useState<Box | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const reduced = prefersReducedMotion();
  const frames = useRef<number[]>([]);
  const frameLoop = useRef(0);
  const absorbed = useRef(onAbsorbed);
  absorbed.current = onAbsorbed;

  useEffect(() => {
    if (open && (phase === "closed" || phase === "closing")) {
      setPhase("opening");
      setTarget("orb");
      setContentShown(false);
    } else if (!open && skipClose && phase !== "closed") {
      setPhase("closed");
    } else if (!open && (phase === "open" || phase === "opening")) {
      setPhase("closing");
      // The liquid starts from the panel's footprint (a panel that mounted open never had a liquid position).
      if (phase === "open") setTarget("panel");
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

  // Phase entry: reduced motion fades on timers; otherwise start the first leg (the rest follows onSettled).
  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let raf = 0;
    if (phase === "opening") {
      if (reduced) {
        raf = requestAnimationFrame(() => setContentShown(true));
        timers.push(setTimeout(() => setPhase("open"), FADE_MS));
      } else {
        startFrames();
        // Two frames: the liquid first paints on the orb, then swells out of it.
        raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => setTarget("stretch"))));
      }
    } else if (phase === "closing") {
      setContentShown(false);
      if (reduced) {
        timers.push(setTimeout(() => setPhase("closed"), FADE_MS));
      } else {
        startFrames();
        setTarget("panel");
        // The text fades out first; only then does the liquid move.
        timers.push(setTimeout(() => setTarget("stretch"), FADE_MS));
      }
    }
    return () => {
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
    };
  }, [phase, reduced, startFrames]);

  useEffect(() => () => cancelAnimationFrame(frameLoop.current), []);

  /** `part` is "box" when the liquid box has settled, "all" once the neck has too. */
  const onSettled = useCallback(
    (reached: Target, part: "box" | "all") => {
      if (phase === "opening") {
        if (reached === "stretch" && part === "all") {
          // The overshoot is (nearly) over: let go of the orb.
          setTarget("panel");
        } else if (reached === "panel" && part === "box") {
          // The panel's shape is still and exact: only now does any text appear. The neck thins on below it.
          setContentShown(true);
        } else if (reached === "panel" && part === "all") {
          stopFrames();
          setTimeout(() => setPhase((p) => (p === "opening" ? "open" : p)), FADE_MS);
        }
      } else if (phase === "closing" && part === "all") {
        if (reached === "stretch") setTarget("orb");
        else if (reached === "orb") {
          stopFrames();
          setPhase("closed");
          absorbed.current?.();
        }
      }
    },
    [phase, stopFrames],
  );

  if (phase === "closed") return null;

  const moving = phase === "opening" || phase === "closing";
  const showStage = moving && !reduced && panelBox !== null;
  const panelClass = ["g-panel", reduced ? "g-panel-reduced" : "g-panel-goo", contentShown ? "is-shown" : ""].filter(Boolean).join(" ");

  return (
    <>
      {showStage && panelBox && <GooStage orb={orb} panel={panelBox} target={target} phase={phase as "opening" | "closing"} quality={gooQuality()} onSettled={onSettled} />}
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

interface Shape extends Box {
  radius: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: Shape, b: Shape, t: number): Shape => ({
  left: lerp(a.left, b.left, t),
  top: lerp(a.top, b.top, t),
  width: Math.max(0, lerp(a.width, b.width, t)),
  height: Math.max(0, lerp(a.height, b.height, t)),
  // The corner never overshoots into a sharper or blobbier shape than either end.
  radius: Math.min(Math.max(lerp(a.radius, b.radius, t), Math.min(a.radius, b.radius)), Math.max(a.radius, b.radius)),
});

/** Which spring drives the box on the leg from `from` to `to`: only the growth out of the orb may overshoot. */
export function legSpring(from: Target | "moving", to: Target, phase: "opening" | "closing"): SpringConfig {
  if (from === "orb" && to === "stretch") return spring.panelOpen;
  return phase === "closing" ? spring.panelClose : spring.panelSettle;
}

/** The neck's width at rest on each target: a strand while the liquid spans orb and panel, nothing otherwise. */
const neckAt = (t: Target, orbWidth: number) => (t === "stretch" ? orbWidth * goo.neckWidth : 0);

function GooStage({
  orb,
  panel,
  target,
  phase,
  quality: q,
  onSettled,
}: {
  orb: Box;
  panel: Box;
  target: Target;
  phase: "opening" | "closing";
  quality: "full" | "lite";
  onSettled(t: Target, part: "box" | "all"): void;
}) {
  // A tight stage around the orb and the panel: the filter's cost scales with its area, never the whole viewport.
  const left = Math.min(orb.left, panel.left);
  const top = Math.min(orb.top, panel.top);
  const width = Math.max(orb.left + orb.width, panel.left + panel.width) - left;
  const height = Math.max(orb.top + orb.height, panel.top + panel.height) - top;
  const rel = (b: Box) => ({ left: b.left - left, top: b.top - top, width: b.width, height: b.height });
  const shapes: Record<Target, Shape> = {
    orb: { ...rel(orb), radius: orb.width / 2 },
    stretch: { ...rel(stretch(orb, panel)), radius: radius.card },
    panel: { ...rel(panel), radius: radius.card },
  };
  // The neck runs vertically from the orb's centre into the panel's near edge (above or below the orb).
  const orbCx = orb.left + orb.width / 2 - left;
  const orbCy = orb.top + orb.height / 2 - top;
  const panelBelow = panel.top > orb.top;
  const edge = (panelBelow ? panel.top + 10 : panel.top + panel.height - 10) - top;
  const neckTop = Math.min(orbCy, edge);
  const neckHeight = Math.abs(edge - orbCy);

  const blob = useRef<HTMLDivElement>(null);
  const neck = useRef<HTMLDivElement>(null);
  const current = useRef<{ at: Target | "moving"; shape: Shape; neck: number }>({
    at: target,
    shape: shapes[target],
    neck: neckAt(target, orb.width),
  });
  const runs = useRef<SpringRun[]>([]);
  const settledCb = useRef(onSettled);
  settledCb.current = onSettled;

  const paint = (s: Shape, n: number) => {
    const el = blob.current;
    if (el) {
      el.style.left = `${s.left}px`;
      el.style.top = `${s.top}px`;
      el.style.width = `${s.width}px`;
      el.style.height = `${s.height}px`;
      el.style.borderRadius = `${s.radius}px`;
    }
    const nk = neck.current;
    if (nk) {
      const w = Math.max(0, n);
      nk.style.left = `${orbCx - w / 2}px`;
      nk.style.top = `${neckTop}px`;
      nk.style.width = `${w}px`;
      nk.style.height = `${neckHeight}px`;
      nk.style.borderRadius = `${w / 2}px`;
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => paint(current.current.shape, current.current.neck), []);

  useEffect(() => {
    const from = current.current;
    if (from.at === target) return;
    const a = from.shape;
    const b = shapes[target];
    const na = from.neck;
    const nb = neckAt(target, orb.width);
    // Low quality lowers the filter's blur and drops its shadow; it never changes the motion.
    const boxCfg = legSpring(from.at, target, phase);
    // Letting go (open): the neck thins on its own, slower spring, so it visibly outlasts the panel's edge. On the
    // close it thickens with the box, so the drain into the orb keeps its pace.
    const neckCfg = phase === "opening" && target === "panel" ? spring.panelNeck : boxCfg;
    // The stretch hands straight over to the next leg, still moving; the end shapes settle fully.
    const handoff = target === "stretch";
    const opts = { snap: !handoff, settleDistance: handoff ? spring.settle.handoff : spring.settle.distance };
    let box = a;
    let n = na;
    let boxDone = false;
    let neckDone = false;
    const done = () => {
      if (!boxDone || !neckDone) return;
      current.current = { at: target, shape: handoff ? box : b, neck: handoff ? n : nb };
      settledCb.current(target, "all");
    };
    runs.current.forEach((r) => r.cancel());
    runs.current = [
      runSpring(
        0,
        1,
        boxCfg,
        (t) => {
          box = mix(a, b, t);
          current.current = { at: "moving", shape: box, neck: n };
          paint(box, n);
        },
        () => {
          boxDone = true;
          settledCb.current(target, "box");
          done();
        },
        opts,
      ),
      runSpring(
        na,
        nb,
        neckCfg,
        (v) => {
          n = v;
          current.current = { at: "moving", shape: box, neck: n };
          paint(box, n);
        },
        () => {
          neckDone = true;
          done();
        },
        opts,
      ),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  useEffect(() => () => runs.current.forEach((r) => r.cancel()), []);

  return (
    <div className="g-goo-stage" style={{ left, top, width, height }} aria-hidden data-goo-quality={q}>
      <Liquid
        blur={q === "full" ? goo.blurFull : goo.blurLite}
        contrast={18}
        fill="var(--g-surface)"
        shadow={q === "full" ? `0 12px 32px ${color.shadow}` : undefined}
        filterPadding={16}
        style={{ width: "100%", height: "100%" }}
      >
        <Liquid.Item observe>
          <div className="g-goo-blob" style={{ ...rel(orb), borderRadius: "50%" }} />
        </Liquid.Item>
        {/* Geometry is written by the springs each frame; liquid-gooey follows the rendered rects. */}
        <Liquid.Item observe>
          <div ref={neck} className="g-goo-blob g-goo-neck" />
        </Liquid.Item>
        <Liquid.Item observe>
          <div ref={blob} className="g-goo-blob g-goo-morph" />
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
