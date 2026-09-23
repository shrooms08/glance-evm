/**
 * The quiet notice left where the orb was after Glance is reloaded or updated under an open page. Plain DOM in its
 * own shadow root, built only from strings we already hold: once the context is invalidated, no extension API works
 * (not even getURL), so nothing here may call one.
 */
import { cssVariables, layer } from "./tokens";

export interface NoticeAnchor {
  right: number;
  bottom: number;
}

let anchor: NoticeAnchor = { right: 24, bottom: 24 };

/** The page UI keeps this current, so the notice appears exactly where the orb was. */
export function rememberOrbAnchor(next: NoticeAnchor): void {
  anchor = next;
}

export const NOTICE_TAG = "glance-updated";
export const NOTICE_TEXT = "Glance was updated. Refresh this page to use it.";

const css = `
${cssVariables(":host")}
.n {
  position: fixed; display: flex; align-items: center; gap: 10px; max-width: min(340px, calc(100vw - 32px));
  padding: 8px 8px 8px 14px; border-radius: 999px; border: 1px solid var(--g-line);
  background: var(--g-surface); color: var(--g-soft); pointer-events: auto;
  font: 400 13px/1.35 var(--g-font); letter-spacing: 0; box-shadow: 0 8px 24px var(--g-shadow);
}
.n button {
  font: 500 13px/1 var(--g-font); border-radius: 999px; cursor: pointer; padding: 7px 12px;
  border: 1px solid var(--g-line-strong); background: var(--g-raised); color: var(--g-text);
}
.n button.go { background: var(--g-lime); border-color: var(--g-lime); color: var(--g-on-lime); }
.n button.x { padding: 7px 9px; background: transparent; border-color: transparent; color: var(--g-mute); }
.n button:focus-visible { outline: 2px solid var(--g-lime); outline-offset: 2px; }
`;

/** Shows the notice once. Returns the host element (for tests), or the existing one if already shown. */
export function showUpdatedNotice(doc: Document = document, at: NoticeAnchor = anchor): HTMLElement {
  const existing = doc.querySelector<HTMLElement>(NOTICE_TAG);
  if (existing) return existing;
  const host = doc.createElement(NOTICE_TAG);
  host.setAttribute("style", `all: initial !important; position: fixed !important; inset: 0 !important; pointer-events: none !important; z-index: ${layer.host} !important;`);
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = css;
  const box = doc.createElement("div");
  box.className = "n";
  box.setAttribute("role", "status");
  box.style.right = `${Math.max(8, at.right)}px`;
  box.style.bottom = `${Math.max(8, at.bottom + 12)}px`;
  const text = doc.createElement("span");
  text.textContent = NOTICE_TEXT;
  const refresh = doc.createElement("button");
  refresh.className = "go";
  refresh.type = "button";
  refresh.textContent = "Refresh";
  refresh.addEventListener("click", () => doc.defaultView?.location.reload());
  const close = doc.createElement("button");
  close.className = "x";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => host.remove());
  box.append(text, refresh, close);
  shadow.append(style, box);
  doc.documentElement.append(host);
  return host;
}
