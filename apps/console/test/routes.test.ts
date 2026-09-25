/**
 * The console's routes, and every URL the Glance extension opens on it. "/" is the public landing page and the
 * Dashboard is /dashboard; installed extensions (and old links) that open the Dashboard at "/?glance=link..." must still
 * get there, and every page the extension links to must exist.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { consolePageUrl } from "../../extension/lib/consoleOrigins";
import { installPageUrl, latestZipUrl } from "../../extension/lib/getGlance";
import { DASHBOARD_PATH, DASHBOARD_REDIRECTS } from "../lib/routes";

const APP = resolve(import.meta.dirname, "../app");
const PUBLIC = resolve(import.meta.dirname, "../public");
const BASE = "https://glance-evm-console.vercel.app";
const VAULT = "0x00000000000000000000000000000000000000a1";

/** Where a request lands after next.config's redirects (the same rules: source "/" plus a query key; query kept). */
function afterRedirects(url: string): string {
  const u = new URL(url, BASE);
  const rule = DASHBOARD_REDIRECTS.find((r) => r.source === u.pathname && r.has.every((h) => u.searchParams.has(h.key)));
  return rule ? `${rule.destination}${u.search}` : `${u.pathname}${u.search}`;
}

/** The file that serves a path: a page in one of the route groups, or a public file. */
function servedBy(path: string): string | null {
  const pathname = new URL(path, BASE).pathname;
  const segs = pathname.split("/").filter(Boolean);
  for (const group of ["(landing)", "(console)"]) {
    const page = resolve(APP, group, ...segs, "page.tsx");
    if (existsSync(page)) return page;
  }
  const file = resolve(PUBLIC, ...segs);
  return segs.length && existsSync(file) ? file : null;
}

describe("the console's routes", () => {
  it("'/' is the landing page and the Dashboard is /dashboard", () => {
    expect(servedBy("/")).toMatch(/\(landing\)\/page\.tsx$/);
    expect(servedBy(DASHBOARD_PATH)).toMatch(/\(console\)\/dashboard\/page\.tsx$/);
  });

  it("every console page still exists", () => {
    for (const p of ["/dashboard", "/start", "/install", "/link", "/limits", "/prices", "/activity"]) expect(servedBy(p), p).not.toBeNull();
  });

  it("a plain '/' is not redirected (visitors see the landing page)", () => {
    expect(afterRedirects("/")).toBe("/");
    expect(afterRedirects("/?utm_source=x")).toBe("/?utm_source=x");
  });

  it("the old Dashboard URLs on '/' land on /dashboard with their query", () => {
    expect(afterRedirects(`/?glance=link&vault=${VAULT}`)).toBe(`/dashboard?glance=link&vault=${VAULT}`);
    expect(afterRedirects(`/?vault=${VAULT}`)).toBe(`/dashboard?vault=${VAULT}`);
    expect(afterRedirects("/?dev=1")).toBe("/dashboard?dev=1");
  });

  it("the redirects are temporary (the landing page can change without browsers caching a 308)", () => {
    for (const r of DASHBOARD_REDIRECTS) expect(r.permanent).toBe(false);
  });
});

describe("the URLs the extension opens", () => {
  it("Get started opens /start", () => {
    const url = consolePageUrl(`${BASE}/`, "start");
    expect(url).toBe(`${BASE}/start`);
    expect(servedBy(url)).toMatch(/\(console\)\/start\/page\.tsx$/);
  });

  it("Link Glance opens the Dashboard with the link card focused, for that vault", () => {
    const url = consolePageUrl(BASE, "link", VAULT);
    expect(url).toBe(`${BASE}/dashboard?glance=link&vault=${VAULT}`);
    expect(afterRedirects(url)).toBe(`/dashboard?glance=link&vault=${VAULT}`);
    expect(servedBy(url)).toMatch(/\(console\)\/dashboard\/page\.tsx$/);
    expect(consolePageUrl(BASE, "link")).toBe(`${BASE}/dashboard?glance=link`);
  });

  it("an installed v0.1.0 extension (which opened '/?glance=link') still reaches the Dashboard", () => {
    expect(afterRedirects(`${BASE}/?glance=link&vault=${VAULT}`)).toBe(`/dashboard?glance=link&vault=${VAULT}`);
  });

  it("Get Glance opens /install and the download is served", () => {
    expect(installPageUrl(`${BASE}/`)).toBe(`${BASE}/install`);
    expect(servedBy(installPageUrl(BASE))).toMatch(/\(console\)\/install\/page\.tsx$/);
    expect(latestZipUrl(BASE)).toBe(`${BASE}/downloads/glance-extension-latest.zip`);
    expect(servedBy(latestZipUrl(BASE))).toMatch(/public\/downloads\/glance-extension-latest\.zip$/);
  });
});
