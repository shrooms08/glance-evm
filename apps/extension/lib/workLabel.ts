/**
 * What heavy work is running on this page's main thread right now ("canvas trace", "mark drawing", "vision", "DOM
 * scan"), so a long task seen during a spoken answer can say what it was. Also a watcher for those long tasks.
 */
import type { LongTask } from "./voiceReport";

let current: string | null = null;
/** When each piece of labelled work ran (performance.now() times), the last 200: a long task is matched by its start. */
const spans: Array<{ label: string; start: number; end: number }> = [];
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Runs `fn` labelled as `label` (sync, or until its promise settles). */
export function during<T>(label: string, fn: () => T): T {
  const before = current;
  current = label;
  const start = now();
  const close = () => {
    spans.push({ label, start, end: now() });
    if (spans.length > 200) spans.shift();
    if (current === label) current = before;
  };
  let out: T;
  try {
    out = fn();
  } catch (err) {
    close();
    throw err;
  }
  if (out instanceof Promise) return out.finally(close) as T;
  close();
  return out;
}

export const workNow = () => current;

/**
 * Hands the main thread back to the page between slices of heavy work (the canvas trace), so no single task runs
 * long: at the next idle moment, or within 50ms.
 */
export function yieldToPage(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 50 });
    else setTimeout(resolve, 0);
  });
}

/** What was running at `t` (a performance.now() time), if anything labelled was. */
export function workAt(t: number): string | null {
  for (let i = spans.length - 1; i >= 0; i--) if (spans[i]!.start <= t + 1 && spans[i]!.end >= t) return spans[i]!.label;
  return current;
}

/** Long tasks (over 50ms) on this page from now until `stop()`, each with what was running. */
export function watchLongTasks(where: LongTask["where"] = "page"): { stop(): LongTask[] } {
  const seen: LongTask[] = [];
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration > 50) seen.push({ at: e.startTime, ms: e.duration, during: workAt(e.startTime), where });
    });
    observer.observe({ type: "longtask", buffered: false });
  } catch {
    observer = null; // no long-task timing here
  }
  return {
    stop() {
      observer?.disconnect();
      return seen;
    },
  };
}
