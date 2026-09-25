/**
 * The landing page's signature effect, as plain logic: pooled glyph particles (no allocation per frame), the burst
 * and trail parameters, and the pixel-art cursor. The canvas drawing lives in app/(landing)/HeroStory.tsx.
 */

import { landing } from "@glance/design";

/** The glyphs and colours of a burst (from the design). */
export const GLYPHS = ["□", "○", "◇", "×", "+", "≡", "‡", "#"] as const;
export const GLYPH_COLOURS = landing.glyphs;

/** Bursts read at a glance: 18 to 24 glyphs, 11 to 13px, flung 30 to 80px. */
export const BURST = { minCount: 18, maxCount: 24, minSize: 11, maxSize: 13, minSpread: 30, maxSpread: 80, minLife: 650, maxLife: 900 } as const;
/** The small trail behind a moving cursor. */
export const TRAIL = { minSize: 10, maxSize: 11.5, minSpread: 4, maxSpread: 12, life: 700 } as const;

/** Enough for several overlapping bursts; past it, the oldest particles are reused. */
export const POOL_SIZE = 256;

export interface Particle {
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** Rotation over its life (radians). */
  dr: number;
  /** Upward drift over its life (px). */
  drift: number;
  glyph: string;
  colour: string;
  t0: number;
  life: number;
  size: number;
}

type Rand = () => number;
const between = (r: Rand, a: number, b: number) => a + r() * (b - a);
const pick = <T>(r: Rand, list: readonly T[]) => list[Math.floor(r() * list.length)] ?? list[0]!;

/**
 * A fixed pool of particles. `spawn` reuses an idle slot (or the oldest live one when all are busy), and `live` holds
 * the active ones in the first `count` slots, so drawing never allocates.
 */
export class ParticlePool {
  readonly slots: Particle[];
  count = 0;
  private readonly rand: Rand;

  constructor(size = POOL_SIZE, rand: Rand = Math.random) {
    this.rand = rand;
    this.slots = Array.from({ length: size }, () => ({ x: 0, y: 0, dx: 0, dy: 0, dr: 0, drift: 0, glyph: "+", colour: landing.fg, t0: 0, life: 1, size: 12 }));
  }

  private next(): Particle {
    if (this.count < this.slots.length) return this.slots[this.count++]!;
    // Full: reuse the oldest (the first slot), moving the rest down is avoided by rotating it to the end.
    const oldest = this.slots.shift()!;
    this.slots.push(oldest);
    return oldest;
  }

  /** A burst at (x, y): 18 to 24 glyphs flung 30 to 80px. Returns how many were spawned. */
  burst(x: number, y: number, now: number): number {
    const r = this.rand;
    const n = Math.round(between(r, BURST.minCount, BURST.maxCount));
    for (let i = 0; i < n; i++) {
      const a = between(r, 0, Math.PI * 2);
      const d = between(r, BURST.minSpread, BURST.maxSpread);
      const p = this.next();
      p.x = x;
      p.y = y;
      p.dx = Math.cos(a) * d;
      p.dy = Math.sin(a) * d;
      p.dr = between(r, -2.2, 2.2);
      p.drift = between(r, -14, -4);
      p.glyph = pick(r, GLYPHS);
      p.colour = pick(r, GLYPH_COLOURS);
      p.t0 = now;
      p.life = between(r, BURST.minLife, BURST.maxLife);
      p.size = between(r, BURST.minSize, BURST.maxSize);
    }
    return n;
  }

  /** One trail glyph just behind a moving cursor. */
  trail(x: number, y: number, now: number) {
    const r = this.rand;
    const a = between(r, 0, Math.PI * 2);
    const d = between(r, TRAIL.minSpread, TRAIL.maxSpread);
    const p = this.next();
    p.x = x + between(r, -4, 4);
    p.y = y + between(r, 6, 14);
    p.dx = Math.cos(a) * d;
    p.dy = Math.sin(a) * d;
    p.dr = between(r, -1, 1);
    p.drift = between(r, -6, -2);
    p.glyph = pick(r, GLYPHS);
    p.colour = pick(r, GLYPH_COLOURS);
    p.t0 = now;
    p.life = TRAIL.life;
    p.size = between(r, TRAIL.minSize, TRAIL.maxSize);
  }

  /** Drops the particles whose life is over (swap-remove: no allocation). */
  prune(now: number) {
    for (let i = 0; i < this.count; ) {
      const p = this.slots[i]!;
      if (now - p.t0 >= p.life) {
        this.count--;
        this.slots[i] = this.slots[this.count]!;
        this.slots[this.count] = p;
      } else i++;
    }
  }
}

/** Where a particle is at `now`, its opacity and rotation (the design's easing: cubic out, fading as k squared). */
export function particleAt(p: Particle, now: number): { x: number; y: number; alpha: number; rotation: number } | null {
  const k = (now - p.t0) / p.life;
  if (k >= 1 || k < 0) return null;
  const e = 1 - Math.pow(1 - k, 3);
  return { x: p.x + p.dx * e, y: p.y + p.dy * e + p.drift * k, alpha: 1 - k * k, rotation: p.dr * e };
}

/** The pixel-art cursor (the design's map): "o" outline, "#" lime fill, "." empty. 9 cells wide, 13 tall. */
export const CURSOR_MAP = ["o........", "oo.......", "o#o......", "o##o.....", "o###o....", "o####o...", "o#####o..", "o######o.", "o###oooo.", "o#oo#o...", "oo.o#o...", "....o#o..", "....oo..."] as const;

/** The cursor at `width` px wide (about 24), as crisp SVG rects in a 9 x 13 grid. */
export function cursorSvg(width = 24): { width: number; height: number; rects: Array<{ x: number; y: number; fill: string }> } {
  const rects: Array<{ x: number; y: number; fill: string }> = [];
  CURSOR_MAP.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c !== ".") rects.push({ x, y, fill: c === "#" ? landing.lime : landing.bg });
    }),
  );
  return { width, height: Math.round((width * CURSOR_MAP.length) / CURSOR_MAP[0].length), rects };
}
