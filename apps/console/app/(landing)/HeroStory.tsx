"use client";
/**
 * The hero story and the page's signature effect. A pixel-art cursor (about 24px, crisp) glides to "Tesla", clicks it
 * (a glyph burst), draws a circle around it, the Glance panel rises, the cursor clicks "Buy $10" (a second burst) and
 * the receipt appears; then it all eases out and loops (12 seconds). A visitor's click anywhere bursts too.
 *
 * One canvas over the page, drawn from a fixed pool of particles (lib/glyphBurst.ts). The loop only runs while the
 * story is on screen and the tab is visible (or while a burst is still fading); with prefers-reduced-motion it shows
 * the finished frame (circle drawn, panel open, receipt shown) and never animates.
 */
import { useEffect, useRef } from "react";
import Image from "next/image";

import { cursorSvg, ParticlePool, particleAt } from "@/lib/glyphBurst";

const LOOP_SECONDS = 12;
/** The static frame for reduced motion: the circle drawn, the panel up, the receipt showing. */
const FINAL_FRAME = 8;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const bump = (s: number, c: number) => Math.max(0, 1 - Math.abs(s - c) / 0.12);

const CURSOR = cursorSvg(24);

export function HeroStory() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const tesla = useRef<HTMLSpanElement>(null);
  const ring = useRef<SVGPathElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const buy = useRef<HTMLDivElement>(null);
  const receipt = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cv = canvas.current;
    const st = stage.current;
    if (!cv || !st) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pool = new ParticlePool();
    const mono = getComputedStyle(st).getPropertyValue("--font-geist-mono").trim() || "ui-monospace";
    let ctx: CanvasRenderingContext2D | null = null;
    let raf = 0;
    let running = false;
    let onScreen = true;
    let t = 0;
    let last = 0;
    let prev = 0;
    let trailFrom: { x: number; y: number } | null = null;

    const size = () => {
      const d = window.devicePixelRatio || 1;
      cv.width = Math.round(innerWidth * d);
      cv.height = Math.round(innerHeight * d);
      ctx = cv.getContext("2d");
      ctx?.setTransform(d, 0, 0, d, 0, 0);
    };

    /** Places everything for story time s (0 to 12). `silent`: no bursts or trail (the reduced-motion frame). */
    const apply = (s: number, silent: boolean) => {
      if (!tesla.current || !buy.current || !cursor.current || !ring.current || !panel.current || !receipt.current) return;
      const sr = st.getBoundingClientRect();
      const rel = (el: Element, fx: number, fy: number) => {
        const r = el.getBoundingClientRect();
        return { x: r.left - sr.left + r.width * fx, y: r.top - sr.top + r.height * fy };
      };
      const rest = { x: sr.width * 0.1, y: sr.height * 0.9 };
      const p1 = rel(tesla.current, 0.55, 0.72);
      const p2 = rel(buy.current, 0.6, 0.62);
      const idle = { x: sr.width * 0.42, y: sr.height * 0.96 };
      const segs: Array<[number, number, { x: number; y: number }, { x: number; y: number }]> = [
        [0, 0.6, rest, rest],
        [0.6, 2, rest, p1],
        [2, 4.4, p1, p1],
        [4.4, 5.8, p1, p2],
        [5.8, 8.4, p2, p2],
        [8.4, 9.8, p2, idle],
        [9.8, 11.2, idle, idle],
        [11.2, 12.01, idle, rest],
      ];
      const [a, b, A, B] = segs.find((g) => s >= g[0] && s < g[1]) ?? segs[4]!;
      const k = ease(clamp01((s - a) / (b - a)));
      let x = A.x + (B.x - A.x) * k;
      let y = A.y + (B.y - A.y) * k;
      const moving = A !== B;
      if (moving) {
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const len = Math.hypot(dx, dy) || 1;
        const off = Math.sin(Math.PI * k) * Math.min(40, len * 0.18);
        x += (-dy / len) * off;
        y += (dx / len) * off;
      }
      const press = Math.max(bump(s, 2.4), bump(s, 6.1));
      cursor.current.style.transform = `translate(${x}px,${y}px) scale(${1 - 0.18 * press})`;
      if (!silent) {
        const now = performance.now();
        if (moving && k > 0.05 && k < 0.95) {
          if (!trailFrom) trailFrom = { x, y };
          else if (Math.hypot(x - trailFrom.x, y - trailFrom.y) > 80) {
            pool.trail(sr.left + x, sr.top + y, now);
            trailFrom = { x, y };
          }
        } else trailFrom = null;
        const crossed = (c: number) => prev < c && s >= c;
        if (crossed(2.4)) pool.burst(sr.left + p1.x, sr.top + p1.y, now);
        if (crossed(6.1)) pool.burst(sr.left + p2.x, sr.top + p2.y, now);
      }
      prev = s;
      const out = 1 - ease(clamp01((s - 10.6) / 0.6));
      ring.current.style.strokeDashoffset = String(1 - ease(clamp01((s - 2.6) / 0.8)));
      ring.current.style.opacity = String(out);
      const pk = ease(clamp01((s - 3.4) / 0.6));
      panel.current.style.opacity = String(pk * out);
      panel.current.style.transform = `translateY(${(1 - pk) * 18 + (1 - out) * 8}px)`;
      buy.current.style.transform = `scale(${1 - 0.05 * bump(s, 6.1)})`;
      const rk = ease(clamp01((s - 6.4) / 0.4)) * out;
      receipt.current.style.opacity = String(rk);
      receipt.current.style.transform = `translateY(${(1 - rk) * 6}px)`;
    };

    const draw = (now: number) => {
      if (!ctx) return;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      pool.prune(now);
      if (!pool.count) return;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let i = 0; i < pool.count; i++) {
        const p = pool.slots[i]!;
        const at = particleAt(p, now);
        if (!at) continue;
        ctx.save();
        ctx.globalAlpha = at.alpha;
        ctx.translate(at.x, at.y);
        ctx.rotate(at.rotation);
        ctx.fillStyle = p.colour;
        ctx.font = `${p.size}px ${mono}`;
        ctx.fillText(p.glyph, 0, 0);
        ctx.restore();
      }
    };

    const story = () => onScreen && !document.hidden;
    const tick = (now: number) => {
      const dt = Math.min(now - last, 50) / 1000;
      last = now;
      if (story()) {
        t = (t + dt) % LOOP_SECONDS;
        apply((t * 12) / LOOP_SECONDS, false);
      }
      draw(now);
      // Nothing to show: stop until the story is back on screen, the tab returns, or someone clicks.
      if (!story() && !pool.count) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (running || reduced) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };

    size();
    const onResize = () => {
      size();
      if (reduced) apply(FINAL_FRAME, true);
    };
    const onDown = (e: PointerEvent) => {
      if (reduced) return;
      pool.burst(e.clientX, e.clientY, performance.now());
      start();
    };
    const onVisibility = () => {
      if (!document.hidden) start();
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = Boolean(entry?.isIntersecting);
        if (onScreen) start();
      },
      { threshold: 0.05 },
    );
    io.observe(st);
    window.addEventListener("resize", onResize);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("visibilitychange", onVisibility);
    if (reduced) requestAnimationFrame(() => apply(FINAL_FRAME, true));
    else start();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <>
      <canvas ref={canvas} className="lp-canvas" aria-hidden="true" />
      <div ref={stage} className="lp-stage" aria-hidden="true">
        <div className="lp-article">
          <div className="lp-article-meta">
            <span>MARKETS</span>
            <span>·</span>
            <span>2 MIN READ</span>
          </div>
          <div className="lp-article-title">
            <span ref={tesla} className="lp-tesla">
              Tesla
              <svg className="lp-ring" viewBox="0 0 120 56" preserveAspectRatio="none">
                <path
                  ref={ring}
                  d="M 10 32 C 6 13, 42 4, 76 6 C 106 8, 119 19, 115 33 C 111 47, 70 53, 38 49 C 12 46, 1 36, 11 22 C 17 13, 31 8, 46 7"
                  pathLength={1}
                  fill="none"
                  style={{ stroke: "var(--lp-lime)" }}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeDasharray="1"
                  strokeDashoffset="1"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </span>{" "}
            jumps 4% after deliveries beat estimates
          </div>
          <div className="lp-lines">
            <div style={{ width: "100%" }} />
            <div style={{ width: "92%" }} />
            <div style={{ width: "60%" }} />
          </div>
        </div>

        <div ref={panel} className="lp-panel" style={{ opacity: 0 }}>
          <div className="lp-panel-head">
            <Image src="/landing/glance-mark.png" alt="" width={16} height={16} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>Glance</span>
            <span style={{ fontSize: 12, color: "var(--lp-dim)" }}>Speaking</span>
            <span className="lp-kbd">⌥ V</span>
          </div>
          <div className="lp-quote">
            <span style={{ fontSize: 14, fontWeight: 600 }}>TSLA</span>
            <span style={{ color: "var(--lp-dim)" }}>·</span>
            <span style={{ fontSize: 20, fontWeight: 500, letterSpacing: "-0.02em" }}>$373.90</span>
            <span className="lp-live">
              <span className="lp-dot" />
              live
            </span>
          </div>
          <svg className="lp-spark" viewBox="0 0 170 52" preserveAspectRatio="none">
            <polyline
              points="0,40 14,40 14,32 30,32 30,44 46,44 46,26 64,26 64,34 80,34 80,20 98,20 98,28 116,28 116,14 134,14 134,22 150,22 150,10 170,10"
              fill="none"
              style={{ stroke: "var(--lp-lime)" }}
              strokeWidth={1.6}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="lp-mono" style={{ fontSize: 11, color: "var(--lp-muted)" }}>
            Vault trades at $373.64 · Chainlink
          </div>
          <div ref={buy} className="lp-buy">
            Buy $10
          </div>
          <div ref={receipt} className="lp-receipt" style={{ opacity: 0 }}>
            <span className="lp-dot" />
            <span>Bought $10 of TSLA · limits checked by your vault</span>
          </div>
        </div>

        <div ref={cursor} className="lp-cursor" data-testid="pixel-cursor">
          <svg width={CURSOR.width} height={CURSOR.height} viewBox="0 0 18 26" shapeRendering="crispEdges">
            {CURSOR.rects.map((r) => (
              <rect key={`${r.x}-${r.y}`} x={r.x * 2} y={r.y * 2} width={2} height={2} fill={r.fill} />
            ))}
          </svg>
        </div>
      </div>
    </>
  );
}
