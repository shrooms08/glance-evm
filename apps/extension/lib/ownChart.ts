/**
 * Where Glance's own chart goes when it's shown on a page (only when asked for: "show me your chart", or a stock's
 * chart on a page with no chart of its own): docked beside the Glance panel, and NEVER over a chart the page has.
 * Pure: boxes in, a box (or null when there's no room anywhere) out.
 */
import type { Box } from "@glance/core/page-chart";

export const OWN_CHART_SIZE = { width: 420, height: 260 };
const SMALL = { width: 320, height: 200 };
const GAP = 12;
const PAD = 4;

export const intersects = (a: Box, b: Box, pad = 0) =>
  a.x < b.x + b.width + pad && b.x < a.x + a.width + pad && a.y < b.y + b.height + pad && b.y < a.y + a.height + pad;

/**
 * The first place that fits inside the viewport and touches neither the panel nor any page chart: left of the panel,
 * above it, below it, then anywhere else on a grid; the same at a smaller size; null when nothing fits.
 */
export function placeOwnChart(panel: Box | null, viewport: { width: number; height: number }, avoid: readonly Box[], size = OWN_CHART_SIZE): Box | null {
  const blocked = [...avoid, ...(panel ? [panel] : [])];
  const fits = (b: Box) => b.x >= 0 && b.y >= 0 && b.x + b.width <= viewport.width && b.y + b.height <= viewport.height && !blocked.some((o) => intersects(b, o, PAD));
  for (const s of [size, SMALL]) {
    const beside: Box[] = panel
      ? [
          { x: panel.x - GAP - s.width, y: panel.y, ...s },
          { x: panel.x - GAP - s.width, y: panel.y + panel.height - s.height, ...s },
          { x: panel.x + panel.width - s.width, y: panel.y - GAP - s.height, ...s },
          { x: panel.x + panel.width - s.width, y: panel.y + panel.height + GAP, ...s },
          { x: panel.x + panel.width + GAP, y: panel.y, ...s },
        ]
      : [];
    const clamp = (b: Box): Box => ({ ...b, x: Math.min(Math.max(0, b.x), viewport.width - b.width), y: Math.min(Math.max(0, b.y), viewport.height - b.height) });
    for (const b of beside.map(clamp)) if (fits(b)) return b;
    // Anywhere else, nearest the panel first.
    const grid: Box[] = [];
    for (let y = 0; y + s.height <= viewport.height; y += 20) for (let x = 0; x + s.width <= viewport.width; x += 20) grid.push({ x, y, ...s });
    const cx = panel ? panel.x + panel.width / 2 : viewport.width;
    const cy = panel ? panel.y + panel.height / 2 : viewport.height;
    grid.sort((a, b) => Math.hypot(a.x + a.width / 2 - cx, a.y + a.height / 2 - cy) - Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy));
    const found = grid.find(fits);
    if (found) return found;
  }
  return null;
}

/**
 * An explicit request for Glance's own chart: "show me your chart", "pull up Glance's chart", "open your chart", "use
 * your chart", "pull up your own". Anything else about a chart on the page annotates the page's chart instead.
 */
export function wantsOwnChart(text: string): boolean {
  const t = text.toLowerCase().replace(/[’]/g, "'");
  return /\b(show|pull up|open|use|bring up|give)( me)? (your|glance'?s|glances)( own)? (chart|graph)\b/.test(t) || /\bpull up (your|glance'?s) own\b|\b(your|glance'?s) own chart\b/.test(t);
}
