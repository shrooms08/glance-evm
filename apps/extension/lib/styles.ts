/**
 * Glance UI stylesheet. Every color, size and timing is a var(--g-*) generated from lib/tokens.ts; nothing here may
 * contain a literal color. The same sheet styles the in-page shadow root, the side panel and the settings page.
 */
import { cssVariables } from "./tokens";

const components = /* css */ `
:host, .g-root {
  all: initial;
  color-scheme: dark;
  font-family: var(--g-font);
  -webkit-font-smoothing: antialiased;
  color: var(--g-text);
}
/* Resets use :where() so they carry no specificity: every component class below wins over them. */
:where(.g-root) *, :where(.g-root) *::before, :where(.g-root) *::after { box-sizing: border-box; margin: 0; padding: 0; }
:where(.g-root) button, :where(.g-root) input { font: inherit; color: inherit; }
:where(.g-root) a { color: var(--g-lime); text-decoration: none; }
:where(.g-root) a:hover { color: var(--g-text); }
:where(.g-root) input[type="checkbox"] { accent-color: var(--g-lime); width: 16px; height: 16px; }
.g-root :focus-visible { outline: 2px solid var(--g-lime); outline-offset: 2px; }

.g-mono { font-family: var(--g-mono); font-variant-numeric: tabular-nums; }
.g-meta { font-size: var(--g-meta-size); line-height: var(--g-meta-leading); color: var(--g-mute); }
.g-data { font-family: var(--g-mono); font-size: var(--g-data-size); color: var(--g-mute); font-variant-numeric: tabular-nums; }
.g-body { font-size: var(--g-body-size); line-height: var(--g-body-leading); text-wrap: pretty; }
.g-ui { font-size: var(--g-ui-size); font-weight: var(--g-ui-weight); }
.g-heading { font-size: var(--g-heading-size); font-weight: var(--g-heading-weight); letter-spacing: var(--g-heading-track); line-height: var(--g-heading-leading); }
.g-figure { font-family: var(--g-mono); font-size: var(--g-figure-size); font-weight: var(--g-figure-weight); letter-spacing: var(--g-figure-track); font-variant-numeric: tabular-nums; }
.g-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ---------- Orb (foundations section 03) ---------- */
.g-orb { position: relative; flex: none; border-radius: 50%; }
.g-orb-disc {
  position: absolute; inset: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
  background: var(--g-canvas);
  box-shadow: 0 0 0 var(--ring-w, 1px) var(--ring, var(--g-idle-ring)), 0 0 0 calc(var(--ring-w, 1px) + 1.5px) var(--g-canvas), 0 6px 18px var(--g-shadow);
  transition: background var(--g-quick) var(--g-ease), box-shadow var(--g-quick) var(--g-ease);
}
.g-orb[data-state="listening"] .g-orb-disc, .g-orb[data-state="success"] .g-orb-disc { background: var(--g-lime); }
.g-orb[data-state="listening"], .g-orb[data-state="speaking"], .g-orb[data-state="success"] { --ring: var(--g-lime); --ring-w: 2px; }
.g-orb[data-state="blocked"] { --ring: var(--g-guard); --ring-w: 2px; }
.g-orb-mark {
  width: calc(var(--size) * 0.84); height: calc(var(--size) * 0.84);
  background: var(--mark-color, var(--g-text));
  -webkit-mask: var(--mark-url) center / contain no-repeat; mask: var(--mark-url) center / contain no-repeat;
  -webkit-mask-mode: luminance; mask-mode: luminance;
}
.g-orb[data-state="thinking"] .g-orb-mark { --mark-color: var(--g-dim-eye); }
.g-orb-pulse { position: absolute; inset: 0; border-radius: 50%; border: 2px solid var(--g-lime); animation: g-pulse var(--g-pulse) ease-out infinite; }
.g-orb-arc { position: absolute; inset: -4px; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--g-lime); border-right-color: var(--g-lime); animation: g-spin var(--g-spin) linear infinite; }
.g-orb-dots { display: block; pointer-events: none; }
@keyframes g-pulse { 0% { transform: scale(1); opacity: .7 } 100% { transform: scale(1.7); opacity: 0 } }
@keyframes g-spin { to { transform: rotate(360deg) } }
/* Cards only fade in: text never slides or scales (hover cards sit over article text; the panel holds prices). */
@keyframes g-in { from { opacity: 0 } to { opacity: 1 } }
/* Idle breathing (lib/tokens.ts breathe): the disc only, never text, and the global reduced-motion rule turns it off. */
@keyframes g-breathe { from { transform: scale(1) } to { transform: scale(var(--g-breathe-scale)) } }
[data-breathe] > .g-orb { animation: g-breathe var(--g-breathe-period) ease-in-out infinite alternate; }

/* ---------- Floating layer ---------- */
.g-layer { position: fixed; inset: 0; pointer-events: none; z-index: var(--g-layer); }
.g-orb-button {
  position: fixed; width: 64px; height: 64px; display: grid; place-items: center;
  border: 0; background: transparent; border-radius: 50%; cursor: grab; pointer-events: auto; touch-action: none;
}
.g-orb-button:active { cursor: grabbing; }
.g-orb-button, .g-orb-motion { will-change: transform; }
.g-orb-motion { display: inline-flex; }
.g-float-badge { position: fixed; pointer-events: auto; }

/* ---------- Surfaces ---------- */
.g-card {
  background: var(--g-surface); border: 1px solid var(--g-line); border-radius: var(--g-r-card);
  box-shadow: 0 18px 48px var(--g-shadow); color: var(--g-text); overflow: hidden;
  animation: g-in var(--g-panel) var(--g-ease);
}
.g-pop { position: fixed; pointer-events: auto; width: 332px; max-width: calc(100vw - 24px); }
.g-panel { position: fixed; pointer-events: auto; width: 360px; max-width: calc(100vw - 24px); max-height: min(560px, calc(100vh - 120px)); display: flex; flex-direction: column; }

/* ---------- Gooey open and close (components/GooPanel.tsx) ---------- */
/* Only .g-goo-blob shapes are filtered, and they are empty. The panel's content is never inside the filtered layer. */
.g-goo-stage { position: fixed; pointer-events: none; }
.g-goo-blob { position: absolute; }
.g-panel-goo { opacity: 0; transition: opacity var(--g-quick) var(--g-ease); }
.g-panel-goo .g-card { animation: none; }
.g-panel-goo.is-shown, .g-panel-reduced.is-shown { opacity: 1; transform: none; }
.g-panel-goo:not(.is-shown), .g-panel-reduced:not(.is-shown) { pointer-events: none; }
/* Reduced motion: no liquid, a short scale-and-fade toward the orb instead. */
.g-panel-reduced { opacity: 0; transform: scale(.96); transition: opacity var(--g-quick) linear, transform var(--g-quick) linear !important; }
.g-panel-reduced .g-card { animation: none; }
.g-section { padding: var(--g-s7); display: flex; flex-direction: column; gap: var(--g-s5); }
.g-section + .g-section { border-top: 1px solid var(--g-line); }
.g-row { display: flex; flex-direction: row; align-items: center; gap: var(--g-s5); }
.g-between { display: flex; align-items: baseline; justify-content: space-between; gap: var(--g-s5); }
.g-grow { flex: 1; min-width: 0; }
.g-scroll { overflow-y: auto; overscroll-behavior: contain; }

/* Panel header (foundations section 04) */
.g-head { display: flex; align-items: center; gap: var(--g-s5); padding: var(--g-s6) var(--g-s7); border-bottom: 1px solid var(--g-line); }
.g-head-title { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.g-state { font-size: var(--g-meta-size); color: var(--g-lime); }
.g-state[data-state="idle"] { color: var(--g-mute); }
.g-state[data-state="blocked"] { color: var(--g-guard); }
.g-kbd { font-family: var(--g-mono); font-size: 11px; color: var(--g-mute); border: 1px solid var(--g-line-strong); border-radius: var(--g-r-pill); padding: 4px 10px; white-space: nowrap; }

/* ---------- Controls ---------- */
.g-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--g-s3);
  min-height: 36px; padding: 0 var(--g-s7); border-radius: var(--g-r-pill);
  font-size: var(--g-ui-size); font-weight: var(--g-ui-weight); cursor: pointer; white-space: nowrap;
  border: 1px solid var(--g-line-strong); background: var(--g-raised); color: var(--g-text);
  transition: background var(--g-quick) var(--g-ease), border-color var(--g-quick) var(--g-ease), opacity var(--g-quick);
}
.g-btn:hover { border-color: var(--g-mute); }
.g-btn:disabled { opacity: .45; cursor: default; }
.g-btn-primary { background: var(--g-lime); border-color: var(--g-lime); color: var(--g-on-lime); }
.g-btn-primary:hover { background: var(--g-text); border-color: var(--g-text); }
.g-btn-ghost { background: transparent; border-color: transparent; color: var(--g-soft); }
.g-btn-ghost:hover { color: var(--g-text); border-color: var(--g-line-strong); }
.g-btn-block { width: 100%; }
.g-icon-btn { width: 32px; height: 32px; min-height: 0; padding: 0; border-radius: 50%; }
.g-chips { display: flex; gap: var(--g-s4); flex-wrap: wrap; }
.g-chip {
  min-height: 34px; padding: 0 var(--g-s6); border-radius: var(--g-r-pill); cursor: pointer;
  font-family: var(--g-mono); font-size: var(--g-ui-size); font-variant-numeric: tabular-nums;
  background: var(--g-raised); border: 1px solid var(--g-line-strong); color: var(--g-text);
}
.g-chip:hover, .g-chip[aria-pressed="true"] { border-color: var(--g-lime); }
.g-input {
  width: 100%; min-height: 38px; padding: 0 var(--g-s6); border-radius: var(--g-r-lg);
  background: var(--g-raised); border: 1px solid var(--g-line-strong); color: var(--g-text);
  font-size: var(--g-ui-size);
}
.g-input::placeholder { color: var(--g-mute); }
.g-input:focus { outline: none; border-color: var(--g-lime); }
.g-amount { position: relative; display: flex; align-items: center; }
.g-amount > span { position: absolute; left: var(--g-s6); color: var(--g-mute); font-family: var(--g-mono); }
.g-amount .g-input { padding-left: 26px; font-family: var(--g-mono); }

/* ---------- Company card ---------- */
.g-ticker { font-family: var(--g-mono); font-size: var(--g-data-size); color: var(--g-mute); border: 1px solid var(--g-line-strong); border-radius: var(--g-r-pill); padding: 2px 8px; }
.g-live { display: inline-flex; align-items: center; gap: 6px; }
.g-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--g-lime); flex: none; }
.g-dot[data-state="CLOSED"], .g-dot[data-state="STALE"] { background: var(--g-guard); }
.g-facts { display: grid; grid-template-columns: auto 1fr; gap: 6px var(--g-s5); }
.g-facts dt { font-size: var(--g-meta-size); color: var(--g-mute); }
.g-facts dd { font-family: var(--g-mono); font-size: var(--g-data-size); color: var(--g-text); text-align: right; font-variant-numeric: tabular-nums; }
.g-skeleton { display: inline-block; height: 1em; width: 6em; border-radius: var(--g-r-xs); background: var(--g-raised); animation: g-glow 1.2s ease-in-out infinite; }
@keyframes g-glow { 50% { opacity: .5 } }

/* ---------- Blocked card: protection, not error ---------- */
.g-guard { border-color: var(--g-guard-line); }
.g-guard-head { background: var(--g-guard-wash); border-bottom: 1px solid var(--g-guard-line); padding: var(--g-s7); display: flex; gap: var(--g-s5); align-items: flex-start; }
.g-guard-eyebrow { font-size: var(--g-meta-size); color: var(--g-guard); display: flex; align-items: center; gap: 6px; }
.g-guard-meta { font-family: var(--g-mono); font-size: var(--g-data-size); color: var(--g-mute); display: flex; align-items: center; gap: 6px; }
.g-shield { width: 14px; height: 14px; flex: none; }

/* ---------- Success ---------- */
.g-success-head { padding: var(--g-s7); display: flex; gap: var(--g-s5); align-items: center; background: var(--g-lime-wash); border-bottom: 1px solid var(--g-line); }

/* ---------- Weekend badge ---------- */
.g-badge {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  font-family: var(--g-mono); font-size: var(--g-data-size); color: var(--g-guard);
  background: var(--g-surface); border: 1px solid var(--g-guard-line); border-radius: var(--g-r-pill); padding: 4px 10px;
  box-shadow: 0 6px 18px var(--g-shadow);
}
.g-badge .g-dot { background: var(--g-guard); }

/* ---------- Notices (offline, no vault) ---------- */
.g-notice { padding: var(--g-s7); display: flex; flex-direction: column; gap: var(--g-s4); }
.g-transcript { font-family: var(--g-mono); font-size: var(--g-data-size); color: var(--g-soft); }
.g-names { display: flex; flex-direction: column; }
.g-name { display: flex; align-items: center; justify-content: space-between; gap: var(--g-s5); padding: 10px var(--g-s7); border: 0; background: transparent; cursor: pointer; text-align: left; border-top: 1px solid var(--g-line); }
.g-name:hover, .g-name:focus-visible { background: var(--g-raised); }

@media (prefers-reduced-motion: reduce) {
  .g-root *:not(.g-panel-reduced), .g-root *::before, .g-root *::after { animation: none !important; transition: none !important; }
  .g-orb-pulse { opacity: .5; transform: scale(1.25); }
}
`;

export function stylesheet(selector = ":host"): string {
  return `${cssVariables(selector === ":host" ? ":host, .g-root" : selector)}\n${components}`;
}
