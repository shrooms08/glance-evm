/** "Never hardcode a color anywhere else": every color lives in lib/tokens.ts. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { color, cssVariables } from "../lib/tokens";

const root = join(import.meta.dirname, "..");
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (["node_modules", ".output", ".wxt", "test", "public"].includes(f)) return [];
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css|html)$/.test(f) ? [p] : [];
  });
}

describe("design tokens", () => {
  it("are the only place a color is written", () => {
    const offenders = files(root)
      .filter((f) => !f.endsWith("lib/tokens.ts"))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => COLOR.test(line.replace(/&#[0-9a-fA-F]+;/g, "")))
          .map(({ line, i }) => `${relative(root, f)}:${i + 1}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });

  it("carry the foundations' key values", () => {
    expect(color.lime).toBe("#C4F135");
    expect(color.onLime).toBe("#0A0A0A");
    expect(color.text).toBe("#F4F4F2");
    expect(color.mute).toBe("#8A8A90");
    expect(color.guard).toBe("#F2B544");
    expect(color.surface).toBe("#0B0B0C");
    expect(color.line).toBe("#1F1F22");
    expect(cssVariables()).toContain("--g-lime: #C4F135;");
  });
});
