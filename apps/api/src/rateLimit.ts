/**
 * Per-IP fixed-window rate limiting, in memory. Enough for a single-instance demo API; a multi-instance deployment
 * would move the counters to a shared store.
 */
import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { SESSION_HEADERS } from "@glance/core/session";

export function clientIp(c: Parameters<MiddlewareHandler>[0], trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** The browser session a request says it comes from (its address only; the signature is checked where it matters). */
export function sessionOf(c: Parameters<MiddlewareHandler>[0]): string | null {
  const s = c.req.header(SESSION_HEADERS.session);
  return s && /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}

/**
 * `keyBy` counts by something other than the client IP (a session); a request it returns null for isn't counted.
 */
export function rateLimit(opts: { limit: number; windowMs?: number; trustProxy: boolean; name: string; keyBy?: (c: Parameters<MiddlewareHandler>[0]) => string | null }): MiddlewareHandler {
  const windowMs = opts.windowMs ?? 60_000;
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    const ip = opts.keyBy ? opts.keyBy(c) : clientIp(c, opts.trustProxy);
    if (ip === null) return next();
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count++;
    const remaining = Math.max(0, opts.limit - entry.count);
    c.header("RateLimit-Limit", String(opts.limit));
    c.header("RateLimit-Remaining", String(remaining));
    c.header("RateLimit-Reset", String(Math.ceil((entry.resetAt - now) / 1000)));
    if (entry.count > opts.limit) {
      c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: { code: "RATE_LIMITED", message: "Too many requests. Try again in a minute." } }, 429);
    }
    await next();
  };
}
