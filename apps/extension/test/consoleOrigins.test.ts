/** Where the extension marks the Glance console: only the configured origins, as exact match patterns. */
import { describe, expect, it } from "vitest";

import { consoleMatchPatterns, DEFAULT_CONSOLE_ORIGINS } from "../lib/consoleOrigins";

describe("consoleMatchPatterns", () => {
  it("defaults to the local console only", () => {
    expect(DEFAULT_CONSOLE_ORIGINS).toBe("http://localhost:3000");
    expect(consoleMatchPatterns(undefined)).toEqual(["http://localhost:3000/*"]);
    expect(consoleMatchPatterns("")).toEqual(["http://localhost:3000/*"]);
  });

  it("takes a comma-separated list of origins, each exactly (scheme, host, port)", () => {
    expect(consoleMatchPatterns("http://localhost:3000, https://Glance-Console.vercel.app/")).toEqual([
      "http://localhost:3000/*",
      "https://glance-console.vercel.app/*",
    ]);
  });

  it("refuses anything that isn't an origin, so a typo fails the build instead of widening the match", () => {
    for (const bad of ["*://*/*", "<all_urls>", "https://*.vercel.app", "https://console.example.com/path", "ftp://x.com", "localhost:3000"]) {
      expect(() => consoleMatchPatterns(bad)).toThrow(/WXT_CONSOLE_ORIGINS/);
    }
  });
});
