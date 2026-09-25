/** The production build's inputs: the hosted API and console (https, no localhost), and the fixed extension ID. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { EXTENSION_ID, extensionIdFor, productionUrl } from "../scripts/build-prod.ts";

describe("build:prod", () => {
  it("takes https addresses: the API may have a path, the console is an origin", () => {
    expect(productionUrl("API_URL", "https://glance-api.up.railway.app/", true)).toBe("https://glance-api.up.railway.app");
    expect(productionUrl("CONSOLE_URL", "https://glance-console.vercel.app", false)).toBe("https://glance-console.vercel.app");
  });

  it.each([
    [undefined, /required/],
    ["http://glance-api.example.com", /must be https/],
    ["https://localhost:8790", /localhost/],
    ["https://user:pw@glance-api.example.com", /plain address/],
    ["https://glance-api.example.com/?key=1", /plain address/],
  ])("refuses %s", (value, why) => {
    expect(() => productionUrl("API_URL", value, true)).toThrow(why);
  });

  it("the manifest's public key gives the fixed extension ID the API's CORS_ORIGINS names", () => {
    const config = readFileSync(resolve(import.meta.dirname, "../wxt.config.ts"), "utf8");
    const key = /key: "([A-Za-z0-9+/=]+)"/.exec(config)![1]!;
    expect(extensionIdFor(key)).toBe(EXTENSION_ID);
    expect(EXTENSION_ID).toBe("gmcdcaoneeohbacbnafjdnkkoojgnogl");
  });
});
