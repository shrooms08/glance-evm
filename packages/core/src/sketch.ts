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
export function circlePath(box: Box, seed = 1, pad = 9): string {
  const r = seeded(seed);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // An ellipse's corners cut in: widen it by a share of the text's size too, so the pen clears the first and last letters.
  const rx = box.width / 2 + pad + box.height * 0.15;
  const ry = box.height / 2 + pad * 0.7;
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

/** A loose, hand-drawn rectangle around `box`: four slightly wobbly sides whose corners overshoot a little. */
export function boxPath(box: Box, seed = 1, pad = 6): string {
  const r = seeded(seed);
  const j = (n: number) => n + (r() - 0.5) * 3;
  const x0 = box.x - pad;
  const y0 = box.y - pad;
  const x1 = box.x + box.width + pad;
  const y1 = box.y + box.height + pad;
  const o = 4; // corner overshoot
  const side = (ax: number, ay: number, bx: number, by: number) => {
    const mx = (ax + bx) / 2 + (r() - 0.5) * 2.5;
    const my = (ay + by) / 2 + (r() - 0.5) * 2.5;
    return `M${f(j(ax))},${f(j(ay))} Q${f(mx)},${f(my)} ${f(j(bx))},${f(j(by))}`;
  };
  return [side(x0 - o, y0, x1, y0), side(x1, y0 - o, x1, y1), side(x1 + o, y1, x0, y1), side(x0, y1 + o, x0, y0)].join(" ");
}

/** A curved, hand-drawn arrow from `from` to `to` (their nearest edges), with a two-stroke head. */
export function arrowPath(from: Box, to: Box, seed = 1): { shaft: string; head: string } {
  const r = seeded(seed);
  const c = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const a = c(from);
  const b = c(to);
  // Leave from, and arrive at, the point of each box nearest the other's center, a few pixels outside it: on a long
  // line of text the arrow lands on the words, not on the far end of the line.
  const edge = (bx: Box, toward: { x: number; y: number }) => {
    const x = Math.min(Math.max(toward.x, bx.x), bx.x + bx.width);
    const y = Math.min(Math.max(toward.y, bx.y), bx.y + bx.height);
    const cx = bx.x + bx.width / 2;
    const cy = bx.y + bx.height / 2;
    const len = Math.hypot(x - cx, y - cy) || 1;
    return { x: x + ((x - cx) / len) * 4, y: y + ((y - cy) / len) * 4 };
  };
  const p0 = edge(from, b);
  const p1 = edge(to, a);
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
  // Bow the curve sideways a little, like a quick pen stroke.
  const bow = Math.min(60, len * 0.25) * (r() > 0.5 ? 1 : -1);
  const nx = -(p1.y - p0.y) / len;
  const ny = (p1.x - p0.x) / len;
  const mx = (p0.x + p1.x) / 2 + nx * bow;
  const my = (p0.y + p1.y) / 2 + ny * bow;
  const shaft = `M${f(p0.x)},${f(p0.y)} Q${f(mx)},${f(my)} ${f(p1.x)},${f(p1.y)}`;
  // The head follows the curve's direction at its end.
  const angle = Math.atan2(p1.y - my, p1.x - mx);
  const h = 11;
  const wing = (d: number) => `M${f(p1.x)},${f(p1.y)} L${f(p1.x - h * Math.cos(angle + d))},${f(p1.y - h * Math.sin(angle + d))}`;
  return { shaft, head: `${wing(0.45)} ${wing(-0.45)}` };
}

/** A marker swipe over each line box: a slightly slanted band, a little taller than the text, filled (not stroked). */
export function highlightPath(lines: readonly Box[], seed = 1): string {
  const r = seeded(seed);
  return lines
    .map((b) => {
      const top = b.y + b.height * 0.12;
      const bottom = b.y + b.height * 0.98;
      const x0 = b.x - 3;
      const x1 = b.x + b.width + 3;
      const s1 = (r() - 0.5) * 2;
      const s2 = (r() - 0.5) * 2;
      return `M${f(x0)},${f(top + s1)} L${f(x1)},${f(top + s2)} L${f(x1 + 1)},${f(bottom + s2)} L${f(x0 - 1)},${f(bottom + s1)} Z`;
    })
    .join(" ");
}
