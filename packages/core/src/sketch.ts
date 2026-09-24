/**
 * Hand-drawn marks for "Show me": a loose circle (two slightly different passes, open where the pen lifts) and a wobbly
 * underline, as SVG path data. Written for Glance in the spirit of rough.js (no code taken from it). Pure and seeded,
 * so the same target always gets the same stroke.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A small deterministic random source (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const f = (n: number) => n.toFixed(1);

/**
 * A loose ellipse around `box` (padded), drawn as a smooth closed-ish curve that overshoots its start a little, like a
 * pen circling a word. Two passes, the second slightly offset.
 */
export function circlePath(box: Box, seed = 1, pad = 6): string {
  const r = seeded(seed);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2 + pad;
  const ry = box.height / 2 + pad * 0.8;
  const pass = (start: number, sweep: number, wobble: number) => {
    const steps = 18;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const a = start + (sweep * i) / steps;
      const k = 1 + (r() - 0.5) * wobble;
      pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
    }
    return smooth(pts);
  };
  const start = -Math.PI / 2 - 0.4 + r() * 0.3;
  return `${pass(start, Math.PI * 2 + 0.35, 0.08)} ${pass(start + 0.2, Math.PI * 2 - 0.1, 0.12)}`;
}

/** A slightly wavy line under `box`, a touch longer than the text, with a second faint pass. */
export function underlinePath(box: Box, seed = 1): string {
  const r = seeded(seed);
  const y = box.y + box.height + 3;
  const x0 = box.x - 3;
  const x1 = box.x + box.width + 4;
  const pass = (dy: number) => {
    const steps = Math.max(4, Math.round((x1 - x0) / 24));
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) pts.push([x0 + ((x1 - x0) * i) / steps, y + dy + (r() - 0.5) * 2.4]);
    return smooth(pts);
  };
  return `${pass(0)} ${pass(1.6)}`;
}

/** Catmull-Rom through the points, as cubic Béziers. */
function smooth(pts: Array<[number, number]>): string {
  let d = `M${f(pts[0]![0])},${f(pts[0]![1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0]!)},${f(c1[1]!)} ${f(c2[0]!)},${f(c2[1]!)} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}
