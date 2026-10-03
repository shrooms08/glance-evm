/**
 * The console's security headers (next.config.ts, docs/audit.md L-13): on every route, the page can't be framed
 * (X-Frame-Options and CSP frame-ancestors, the only CSP directive), referrers keep only the origin cross-site, and
 * responses aren't type-sniffed.
 */
import { describe, expect, it } from "vitest";

import config from "../next.config";

describe("security headers", () => {
  it("every route gets the four headers, and the CSP is frame-ancestors only", async () => {
    const rules = await config.headers!();
    expect(rules).toEqual([
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ]);
  });
});
