/**
 * The console's root CSS: the bundled Geist faces (the extension's own files, under the same Glance-only names), every
 * design token as a --g-* variable, and the two themes as --t-* variables. Generated from @glance/design, so the
 * console can't drift from the extension.
 */
import { cssVariables, fontFaces, themeVariables } from "@glance/design";

export function rootCss(): string {
  return [
    fontFaces((path) => path),
    cssVariables(":root"),
    `:root, :root[data-theme="dark"] {\n  color-scheme: dark;\n  ${themeVariables("dark")}\n}`,
    `:root[data-theme="light"] {\n  color-scheme: light;\n  ${themeVariables("light")}\n}`,
  ].join("\n");
}
