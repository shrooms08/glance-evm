/** "Never hardcode a color anywhere else": in the console too, every color lives in @glance/design. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { color, themes } from "@glance/design";
import { describe, expect, it } from "vitest";

import { rootCss } from "../lib/styles";

const root = join(import.meta.dirname, "..");
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (["node_modules", ".next", "test", "public", ".vercel"].includes(f)) return [];
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css|html|mjs)$/.test(f) ? [p] : [];
  });
}

describe("design tokens in the console", () => {
  it("are the only place a color is written", () => {
    const offenders = files(root).flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => COLOR.test(line.replace(/&#[0-9a-fA-F]+;/g, "")))
        .map(({ line, i }) => `${relative(root, f)}:${i + 1}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("are the extension's own: lime, black, Geist", () => {
    expect(color.lime).toBe("#C4F135");
    expect(themes.dark.accent).toBe(color.lime);
    expect(themes.dark.canvas).toBe("#000000");
    expect(rootCss()).toContain("--g-lime: #C4F135;");
    expect(rootCss()).toContain("font-family:'Glance Geist'");
    expect(rootCss()).toContain("font-family:'Glance Geist Mono'");
  });

  it("dark is the default and light defines every same variable", () => {
    expect(Object.keys(themes.light).sort()).toEqual(Object.keys(themes.dark).sort());
    const css = rootCss();
    expect(css).toMatch(/:root, :root\[data-theme="dark"\] \{\s*color-scheme: dark;/);
    expect(css).toContain(':root[data-theme="light"]');
  });
});
