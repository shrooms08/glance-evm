/**
 * One kept-alive connection pool for every Claude call (the resolver, voice intents, "Why it moved", Show me), so a
 * request doesn't pay a new TLS handshake to api.anthropic.com (about 0.8s from far away). warmAnthropic() opens a
 * connection ahead of time, on Option+V key down: a bare HEAD with no key, nothing sent.
 */
import { Agent, fetch as undiciFetch } from "undici";

const pool = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 8 });

export const anthropicFetch = ((url: string | URL, init?: RequestInit) =>
  undiciFetch(url as never, { ...(init as object), dispatcher: pool } as never)) as unknown as typeof fetch;

let lastWarm = 0;
/** Leaves a warm connection to Anthropic in the pool (at most once a second; errors ignored). */
export function warmAnthropic(now = Date.now()) {
  if (now - lastWarm < 1_000) return;
  lastWarm = now;
  void anthropicFetch("https://api.anthropic.com/", { method: "HEAD", signal: AbortSignal.timeout(5_000) }).then(
    (r) => r.body?.cancel(),
    () => {},
  );
}
