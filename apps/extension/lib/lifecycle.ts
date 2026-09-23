/**
 * Extension context invalidation: when Glance is reloaded or updated, the content scripts already running in open
 * tabs are orphaned. Every extension API call from them then throws "Extension context invalidated". That is an
 * expected lifecycle event, not an error: we notice it once, shut the page UI down quietly, and never log it.
 *
 * Detection, from fastest to slowest:
 *   - a long-lived port to the background disconnects the moment the extension goes away (watchContext);
 *   - a cheap chrome.runtime.id check (undefined once invalidated) on a timer and whenever the tab becomes visible;
 *   - send() and safely() catch the error on any call that still slips through;
 *   - a last-resort window listener swallows stray "invalidated" rejections from library code.
 */
import { browser } from "wxt/browser";

const INVALIDATED = /extension context invalidated/i;

export function isInvalidatedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : (err as { message?: unknown } | null)?.message;
  return typeof message === "string" && INVALIDATED.test(message);
}

/** False once the extension has been reloaded, updated or removed under this page. */
export function contextAlive(): boolean {
  try {
    return Boolean(browser.runtime?.id);
  } catch {
    return false;
  }
}

let lost = false;
const handlers = new Set<() => void>();

export function isContextLost(): boolean {
  return lost;
}

/** Called once, on the first sign of invalidation. Returns an unsubscribe function. */
export function onContextLost(cb: () => void): () => void {
  if (lost) {
    cb();
    return () => {};
  }
  handlers.add(cb);
  return () => handlers.delete(cb);
}

/** Marks the context lost and runs every handler exactly once. Later calls do nothing. */
export function reportContextLost(): void {
  if (lost) return;
  lost = true;
  for (const cb of [...handlers]) {
    try {
      cb();
    } catch {
      // A handler touching a dead API must not stop the others, and must not log.
    }
  }
  handlers.clear();
}

/** A promise that never settles: what callers get once the context is gone, so nothing downstream runs or logs. */
const never = <T>() => new Promise<T>(() => {});

/**
 * runtime.sendMessage that survives invalidation. In Chrome the call throws synchronously once the context is dead,
 * so a plain `.catch()` is not enough. Other errors (no listener, a closed tab) reject as usual.
 */
export function send<T = unknown>(message: unknown): Promise<T> {
  if (lost) return never();
  if (!contextAlive()) {
    reportContextLost();
    return never();
  }
  try {
    return (browser.runtime.sendMessage(message) as Promise<T>).catch((err: unknown) => {
      if (isInvalidatedError(err) || !contextAlive()) {
        reportContextLost();
        return never<T>();
      }
      throw err;
    });
  } catch (err) {
    if (isInvalidatedError(err) || !contextAlive()) {
      reportContextLost();
      return never();
    }
    return Promise.reject(err);
  }
}

/** Runs an extension API call (storage, getURL, removeListener) and turns invalidation into a quiet shutdown. */
export function safely<T>(fn: () => T, fallback: T): T {
  if (lost) return fallback;
  try {
    const out = fn();
    if (out instanceof Promise) {
      return out.catch((err: unknown) => {
        if (isInvalidatedError(err) || !contextAlive()) {
          reportContextLost();
          return never();
        }
        throw err;
      }) as T;
    }
    return out;
  } catch (err) {
    if (isInvalidatedError(err) || !contextAlive()) {
      reportContextLost();
      return fallback;
    }
    throw err;
  }
}

export const CONTEXT_PORT = "glance:content";
const CHECK_MS = 3_000;
const RECONNECT_MS = 1_000;

/**
 * Notices invalidation promptly instead of at the user's next action. The port to the background also disconnects
 * when Chrome stops an idle service worker; then runtime.id is still set and we simply reconnect.
 * Returns a function that stops watching.
 */
export function watchContext(win: Window = window): () => void {
  let stopped = false;
  let port: { disconnect(): void } | null = null;
  let reconnect: ReturnType<typeof setTimeout> | undefined;

  const check = () => {
    if (!stopped && !contextAlive()) reportContextLost();
  };
  const connect = () => {
    if (stopped || lost) return;
    try {
      const p = browser.runtime.connect({ name: CONTEXT_PORT });
      p.onDisconnect.addListener(() => {
        port = null;
        if (stopped) return;
        if (!contextAlive()) return reportContextLost();
        reconnect = setTimeout(connect, RECONNECT_MS);
      });
      port = p;
    } catch {
      check();
    }
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    if (!isInvalidatedError(e.reason)) return;
    e.preventDefault();
    reportContextLost();
  };
  const onError = (e: ErrorEvent) => {
    if (!isInvalidatedError(e.error ?? e.message)) return;
    e.preventDefault();
    reportContextLost();
  };

  connect();
  const timer = setInterval(check, CHECK_MS);
  win.addEventListener("unhandledrejection", onRejection);
  win.addEventListener("error", onError);
  win.document.addEventListener("visibilitychange", check);
  win.addEventListener("focus", check);

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(reconnect);
    win.document.removeEventListener("visibilitychange", check);
    win.removeEventListener("focus", check);
    try {
      port?.disconnect();
    } catch {
      // already gone
    }
    // The rejection guard stays: stragglers from the dead context may still surface after shutdown.
  };
  onContextLost(stop);
  return stop;
}

/** For tests only. */
export function resetLifecycleForTests(): void {
  lost = false;
  handlers.clear();
}
