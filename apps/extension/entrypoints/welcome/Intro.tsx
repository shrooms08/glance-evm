/**
 * The Welcome page's spoken intro: a large dotted orb in the middle of the page, breathing when idle and swelling with
 * the voice's loudness (an AnalyserNode on the intro's own audio), one caption at a time under it, in step with the
 * pre-recorded lines (lib/intro.ts). "Skip intro" (or Escape) goes straight to the end: "Set me up" and "Replay intro".
 * Under reduced motion the orb holds still with a soft pulse.
 */
import { color } from "@glance/design";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { INTRO_LINES, introFile, introStep, LINE_GAP_MS, type IntroState } from "../../lib/intro";

/** Plays the intro's lines. Real: Web Audio in this page; tests pass a fake. */
export interface IntroPlayer {
  /** Starts line `i`; "blocked" when the browser won't play sound without a click. `onEnded` fires when it's done. */
  play(i: number, onEnded: () => void): Promise<"playing" | "blocked">;
  stop(): void;
  /** How loud the voice is right now, 0 to 1. */
  level(): number;
}

/** The real player: one audio element through an AudioContext with an analyser on it. */
export function webIntroPlayer(urlFor: (path: string) => string): IntroPlayer {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  const el = new Audio();
  el.preload = "auto";
  const buf = new Uint8Array(1024);
  return {
    async play(i, onEnded) {
      try {
        if (!ctx) {
          ctx = new AudioContext();
          analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          ctx.createMediaElementSource(el).connect(analyser).connect(ctx.destination);
        }
        // Without a click, the context may stay suspended: that is "blocked", never a silent caption.
        await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 400))]);
        if (ctx.state !== "running") return "blocked";
        el.onended = () => onEnded();
        el.src = urlFor(introFile(i));
        await el.play();
        return "playing";
      } catch {
        return "blocked";
      }
    },
    stop() {
      el.onended = null;
      el.pause();
    },
    level() {
      if (!analyser || el.paused) return 0;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / buf.length) * 4);
    },
  };
}

const prefersReduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The dotted sphere: points on a sphere, turning slowly, swelling with `level()`. */
function IntroOrb({ level, reduced, size = 340 }: { level(): number; reduced: boolean; size?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    g.scale(dpr, dpr);
    // A Fibonacci sphere: evenly spread points.
    const N = 640;
    const pts = Array.from({ length: N }, (_, i) => {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = i * Math.PI * (3 - Math.sqrt(5));
      return { x: Math.cos(th) * r, y, z: Math.sin(th) * r };
    });
    let raf = 0;
    let smooth = 0;
    const t0 = performance.now();
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      smooth += (level() - smooth) * 0.25;
      const breathe = reduced ? 0 : Math.sin(t * (2 * Math.PI / 4.2)) * 0.025;
      const R = (size / 2 - 24) * (0.86 + breathe + smooth * 0.16);
      const a = reduced ? 0.6 : t * 0.18;
      const tilt = 0.35;
      g.clearRect(0, 0, size, size);
      const glow = g.createRadialGradient(size / 2, size / 2, R * 0.2, size / 2, size / 2, R * 1.25);
      glow.addColorStop(0, color.limeWash);
      glow.addColorStop(1, "transparent");
      g.fillStyle = glow;
      g.fillRect(0, 0, size, size);
      g.fillStyle = color.lime;
      for (const p of pts) {
        const x1 = p.x * Math.cos(a) + p.z * Math.sin(a);
        const z1 = -p.x * Math.sin(a) + p.z * Math.cos(a);
        const y2 = p.y * Math.cos(tilt) - z1 * Math.sin(tilt);
        const z2 = p.y * Math.sin(tilt) + z1 * Math.cos(tilt);
        const depth = (z2 + 1) / 2; // 0 at the back, 1 at the front
        g.globalAlpha = 0.18 + depth * 0.82;
        const d = 0.8 + depth * 1.9 + smooth * 1.2;
        g.beginPath();
        g.arc(size / 2 + x1 * R, size / 2 + y2 * R, d, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    draw();
    // Reduced motion: drawn once, held still; the soft pulse is the element's own opacity (CSS).
    return () => cancelAnimationFrame(raf);
  }, [level, reduced, size]);
  return (
    <canvas
      ref={canvas}
      aria-hidden
      data-testid="intro-orb"
      style={{ width: size, height: size, ...(reduced ? { animation: "g-intro-pulse 2.4s ease-in-out infinite" } : {}) }}
    />
  );
}

export function Intro({ autoplay, player, onSetUp }: { autoplay: boolean; player: IntroPlayer; onSetUp(): void }) {
  const [state, dispatch] = useReducer(introStep, autoplay ? ({ phase: "ready" } as IntroState) : ({ phase: "end" } as IntroState));
  const [reduced] = useState(prefersReduced);
  const gap = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const run = useRef(0);

  // Plays the current line; when it ends, a short pause, then the next.
  useEffect(() => {
    if (state.phase !== "playing") return;
    const id = ++run.current;
    void player.play(state.line, () => {
      if (id !== run.current) return;
      gap.current = setTimeout(() => id === run.current && dispatch({ type: "lineEnded" }), LINE_GAP_MS);
    }).then((r) => {
      if (r === "blocked" && id === run.current) dispatch({ type: "blocked" });
    });
    return () => clearTimeout(gap.current);
  }, [state, player]);

  // On load: try to play.
  useEffect(() => {
    if (autoplay) dispatch({ type: "start" });
  }, [autoplay]);

  const skip = useCallback(() => {
    run.current++;
    clearTimeout(gap.current);
    player.stop();
    dispatch({ type: "skip" });
  }, [player]);
  const replay = useCallback(() => {
    run.current++;
    clearTimeout(gap.current);
    player.stop();
    dispatch({ type: "start" });
  }, [player]);

  // Escape skips, like the link.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state.phase !== "end") skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [skip, state.phase]);

  const caption = state.phase === "playing" ? INTRO_LINES[state.line]!.caption : state.phase === "end" ? INTRO_LINES.at(-1)!.caption : null;
  const level = useCallback(() => (state.phase === "playing" ? player.level() : 0), [player, state.phase]);

  return (
    <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 28, padding: "24px 24px 64px", minHeight: "calc(100vh - 64px)", boxSizing: "border-box" }}>
      <style>{"@keyframes g-intro-pulse{0%,100%{opacity:.75}50%{opacity:1}}@keyframes g-intro-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}"}</style>
      {state.phase !== "end" && (
        <button className="g-btn g-btn-ghost g-meta" onClick={skip} style={{ position: "absolute", top: 12, right: 16 }}>
          Skip intro
        </button>
      )}
      <IntroOrb level={level} reduced={reduced || state.phase === "blocked"} />
      <div aria-live="polite" style={{ minHeight: 110, maxWidth: 820, textAlign: "center" }}>
        {caption && (
          <p
            key={state.phase === "playing" ? state.line : "end"}
            data-testid="intro-caption"
            style={{ margin: 0, fontFamily: "var(--g-font)", fontSize: 40, lineHeight: 1.2, fontWeight: 500, letterSpacing: "-0.01em", color: "var(--g-text)", animation: "g-intro-in 420ms ease-out both" }}
          >
            {caption}
          </p>
        )}
      </div>
      {state.phase === "blocked" && (
        <button className="g-btn g-btn-primary" onClick={() => dispatch({ type: "start" })} autoFocus>
          Tap to meet Glance
        </button>
      )}
      {state.phase === "end" && (
        <div className="g-row" style={{ gap: 12, animation: "g-intro-in 500ms ease-out both" }}>
          <button className="g-btn g-btn-primary" onClick={onSetUp} autoFocus>
            Set me up
          </button>
          <button className="g-btn" onClick={replay}>
            Replay intro
          </button>
        </div>
      )}
    </div>
  );
}
