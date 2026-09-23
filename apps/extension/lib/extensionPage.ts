/** Styles for Glance's own extension pages (side panel, settings): fonts, tokens and components, dark canvas. */
import { stylesheet } from "./styles";
import { fontFaces } from "./tokens";

export function mountPageStyles() {
  const style = document.createElement("style");
  style.textContent = `${fontFaces((p) => p)}\n${stylesheet(":root, .g-root")}\nhtml, body { margin: 0; height: 100%; background: var(--g-canvas); color: var(--g-text); font-family: var(--g-font); }`;
  document.head.append(style);
}
