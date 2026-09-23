/**
 * Glance design tokens, transcribed from design/Glance Foundations.html (v1). This is the ONLY file in the extension
 * allowed to contain a color value; test/tokens.test.ts fails the build if a hex, rgb() or hsl() color appears
 * anywhere else. Components use the CSS variables that cssVariables() generates.
 */

export const color = {
  // Core (in-page surfaces are always dark)
  canvas: "#000000", // Page and orb disc
  surface: "#0B0B0C", // Cards, panels, hover card
  raised: "#161618", // Inputs, pills, selected row
  line: "#1F1F22", // Hairlines and dividers
  lineStrong: "#26262A", // Pill and chip borders
  ringMuted: "#3A3A40", // Legend dot outline
  mute: "#8A8A90", // Meta, ages, labels
  soft: "#A1A1A8", // Secondary text on dark
  text: "#F4F4F2", // Primary text and the eye
  lime: "#C4F135", // Active, primary action, live
  onLime: "#0A0A0A", // Text on lime
  guard: "#F2B544", // Blocked (and the market-closed guard badge). Protection, never decoration
  // Light mode (settings page is dark; these are for underlines on light host pages)
  paper: "#F6F6F3",
  card: "#FFFFFF",
  ink: "#0A0A0A",
  limeInk: "#4F7A00", // Lime as text/icon on light
  guardInk: "#9A5B00", // Guard as text on light
  // Translucent helpers
  idleRing: "rgba(255,255,255,.18)",
  dimEye: "rgba(244,244,242,.45)",
  shadow: "rgba(0,0,0,.35)",
  scrim: "rgba(0,0,0,.55)",
  limeWash: "rgba(196,241,53,.10)",
  guardWash: "rgba(242,181,68,.10)",
  guardLine: "rgba(242,181,68,.35)",
} as const;

export const font = {
  // Registered under Glance-specific names so we never collide with a host page's own Geist.
  sans: "'Glance Geist', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'Glance Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

/** Type scale: size px / weight / letter-spacing / line-height. Mono styles use tabular figures. */
export const type = {
  display: { size: 56, weight: 500, track: "-0.03em", leading: 1.05 },
  title: { size: 28, weight: 500, track: "-0.02em", leading: 1.15 },
  heading: { size: 20, weight: 500, track: "-0.01em", leading: 1.2 },
  body: { size: 15, weight: 400, track: "0", leading: 1.45 },
  ui: { size: 13, weight: 500, track: "0", leading: 1.3 },
  meta: { size: 12, weight: 400, track: "0", leading: 1.35 },
  figure: { size: 20, weight: 500, track: "-0.01em", leading: 1.15 }, // Geist Mono
  data: { size: 12, weight: 400, track: "0", leading: 1.35 }, // Geist Mono
} as const;

/** Spacing steps used by the foundations layout. */
export const space = { 1: 2, 2: 4, 3: 6, 4: 8, 5: 12, 6: 14, 7: 16, 8: 18, 9: 20, 10: 24, 11: 28, 12: 32 } as const;

export const radius = { xs: 6, sm: 8, md: 10, lg: 12, xl: 14, card: 16, panel: 18, pill: 999 } as const;

/** Motion, from the foundations keyframes. */
export const motion = {
  pulse: "1.3s", // listening ring, ease-out
  spin: "0.9s", // thinking arc, linear
  bar: "0.8s", // speaking bars, ease-in-out, staggered
  barDelays: [0, 0.15, 0.3, 0.45],
  successHoldMs: 2000, // success holds, then back to idle
  quick: "120ms",
  panel: "180ms",
  ease: "cubic-bezier(.2,.8,.2,1)",
} as const;

/**
 * Springs: the weight behind the orb and panel. Each is { response, damping }:
 *   response  seconds for one natural oscillation. Lower is snappier, higher is heavier.
 *   damping   damping ratio. 1 = critically damped (no overshoot). Below 1 overshoots once, by about
 *             0.72 -> 4%, 0.8 -> 1.5%, 0.6 -> 9.5%, 0.5 -> 16%. Keep it at 0.5 or above: this product handles money.
 * Springs react to distance and speed (they carry velocity), unlike easing curves. They never run on text, the confirm
 * card, or hover cards, and not at all under prefers-reduced-motion.
 */
/**
 * The liquid: the orb, the panel and the dock movements are all liquid-gooey items in one <Liquid> container, moved by
 * the library's own transition. The goo filter merges them as they move; the overshoot curve gives the wobble.
 *   duration     ms per beat (open, close, dock, undock). Higher reads heavier.
 *   ease         the overshoot curve. Its second y control point (1.56) is the bounce: 1 = none, 1.3 = subtle,
 *                1.56 = the library's example, 1.8+ = rubbery. The first x (0.34) sets how fast it leaves.
 *   stagger      ms between items, so the mass arrives in sequence and reads as one substance. 0 = all at once.
 *   blur         goo blur (px): how far apart pieces still bridge. Higher = longer, softer necks.
 *   contrast     edge sharpness: lower = softer, more liquid edge; higher = crisper.
 *   blurLite     blur on pages that can't hold frame rate (the timing never changes).
 *   seedScale    how small the panel's liquid starts, inside the orb.
 *   droplet      the size of the droplet that leads the panel out of the orb, as a fraction of the orb.
 *   dockTrail    the droplets that trail the orb to the edge (fractions of the orb), one stagger apart. They overlap
 *                as they go, so the goo draws one mass stretching toward the edge. Fewer or smaller = more droplet-y.
 *   panelLeadMs  how long before the last liquid leaves the screen to request the side panel (it takes a moment).
 */
export const liquid = {
  duration: 550,
  ease: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  stagger: 40,
  blur: 13.5,
  contrast: 12,
  blurLite: 8,
  seedScale: 0.12,
  droplet: 0.7,
  dockTrail: [0.9, 0.8, 0.7],
  panelLeadMs: 150,
} as const;

/**
 * Springs for the orb's own small motions (not the liquid): drag lag, the release jiggle, the blocked shake.
 * Each is { response, damping }: response = seconds per natural oscillation (lower is snappier); damping = ratio,
 * 1 = no overshoot, lower overshoots once.
 */
export const spring = {
  /** Drag: how far the orb lags behind the cursor. Critically damped: it catches up without passing it. */
  dragFollow: { response: 0.12, damping: 1 },
  /** Drag release: one jiggle, scaled by release speed (px/s x perSpeed), never more than `maxKick`. */
  dragRelease: { response: 0.26, damping: 0.5, perSpeed: 0.00003, maxKick: 0.04 },
  /** Blocked: a short horizontal shake, starting `kick` px to the side. */
  blockedShake: { response: 0.14, damping: 0.35, kick: 4 },
  /** When a spring counts as done: within `distance` of its travel, moving slower than `speed` travels per second. */
  settle: { distance: 0.01, speed: 0.5 },
  /** Hard cap on any one spring: past it, it snaps. */
  maxMs: 700,
} as const;

/** Idle: a slow breath so the orb never looks frozen. Noticeable only if you stare. Dropped first on slow pages. */
export const breathe = { period: "7s", scale: 1.012 } as const;

/** Orb geometry. */
export const orb = {
  floating: 56,
  hitArea: 64,
  ringBudget: 2,
  small: 40,
  tiny: 28,
  docked: 32,
  markScale: 0.84,
  keyline: 1.5,
} as const;

/**
 * z-index for our in-page host: the maximum. Consent banners and modal backdrops often use it too; our host is the last
 * element in the document, so it wins the tie and the orb is never buried.
 */
export const layer = { host: 2147483647 } as const;

/** CSS custom properties for every token, for use inside our shadow roots and extension pages. */
export function cssVariables(selector = ":host"): string {
  const vars: string[] = [];
  for (const [k, v] of Object.entries(color)) vars.push(`--g-${kebab(k)}: ${v};`);
  vars.push(`--g-font: ${font.sans};`, `--g-mono: ${font.mono};`);
  for (const [k, v] of Object.entries(type)) {
    vars.push(`--g-${k}-size: ${v.size}px;`, `--g-${k}-weight: ${v.weight};`, `--g-${k}-track: ${v.track};`, `--g-${k}-leading: ${v.leading};`);
  }
  for (const [k, v] of Object.entries(space)) vars.push(`--g-s${k}: ${v}px;`);
  for (const [k, v] of Object.entries(radius)) vars.push(`--g-r-${k}: ${v}px;`);
  vars.push(
    `--g-pulse: ${motion.pulse};`,
    `--g-spin: ${motion.spin};`,
    `--g-bar: ${motion.bar};`,
    `--g-quick: ${motion.quick};`,
    `--g-panel: ${motion.panel};`,
    `--g-ease: ${motion.ease};`,
    `--g-breathe-period: ${breathe.period};`,
    `--g-breathe-scale: ${breathe.scale};`,
    `--g-layer: ${layer.host};`,
  );
  return `${selector} {\n  ${vars.join("\n  ")}\n}`;
}

/**
 * @font-face rules for the bundled Geist and Geist Mono (latin + latin-ext). Fonts must be declared in the document,
 * not inside a shadow root, so the content script injects these into the page under Glance-only family names.
 */
export function fontFaces(url: (path: string) => string): string {
  const face = (family: string, file: string, range: string) =>
    `@font-face{font-family:'${family}';font-style:normal;font-weight:100 900;font-display:swap;src:url("${url(`/fonts/${file}`)}") format('woff2');unicode-range:${range};}`;
  const latin = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
  const latinExt = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
  return [
    face("Glance Geist", "geist-latin.woff2", latin),
    face("Glance Geist", "geist-latin-ext.woff2", latinExt),
    face("Glance Geist Mono", "geist-mono-latin.woff2", latin),
    face("Glance Geist Mono", "geist-mono-latin-ext.woff2", latinExt),
  ].join("\n");
}

/** The page-scope rule for company underlines (CSS Custom Highlight API). Colour picked for the host's background. */
export function highlightRule(name: string, hostIsLight: boolean): string {
  const c = hostIsLight ? color.limeInk : color.lime;
  return `::highlight(${name}){text-decoration-line:underline;text-decoration-style:dotted;text-decoration-thickness:2px;text-decoration-color:${c};text-underline-offset:3px;}`;
}

/** The brief emphasis when the side panel reveals a mention: a soft lime wash behind the words. */
export function focusRule(name: string, hostIsLight: boolean): string {
  return `::highlight(${name}){background-color:${hostIsLight ? "rgba(79,122,0,.18)" : color.limeWash};}`;
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** True when a computed CSS color (e.g. getComputedStyle(body).backgroundColor) is light. Transparent counts as light. */
export function isLightColor(css: string): boolean {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/i.exec(css);
  if (!m) return true;
  const alpha = m[4] === undefined ? 1 : Number(m[4]);
  if (alpha < 0.5) return true; // mostly transparent: the browser's default white shows through
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}
