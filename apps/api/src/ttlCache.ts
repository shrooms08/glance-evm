/**
 * A small JSON cache with a time-to-live, in memory and (optionally) in a file under the gitignored .cache dir, so a
 * restart doesn't pay again. Used for Finnhub responses (15 minutes) and "Why it moved" answers (3 hours).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class TtlCache<T> {
  private entries: Record<string, { at: number; value: T }> = {};

  constructor(
    private readonly file: string | null,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly max = 500,
  ) {
    if (!file) return;
    try {
      this.entries = (JSON.parse(readFileSync(file, "utf8")) as { entries?: Record<string, { at: number; value: T }> }).entries ?? {};
    } catch {
      this.entries = {};
    }
  }

  get(key: string): { value: T; at: number } | null {
    const hit = this.entries[key];
    if (!hit || this.now() - hit.at >= this.ttlMs) return null;
    return hit;
  }

  set(key: string, value: T): void {
    const now = this.now();
    this.entries[key] = { at: now, value };
    for (const [k, v] of Object.entries(this.entries)) if (now - v.at >= this.ttlMs) delete this.entries[k];
    const keys = Object.keys(this.entries);
    if (keys.length > this.max) keys.sort((a, b) => this.entries[a]!.at - this.entries[b]!.at).slice(0, keys.length - this.max).forEach((k) => delete this.entries[k]);
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = join(dirname(this.file), `.${now}-${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify({ entries: this.entries }));
      renameSync(tmp, this.file);
    } catch {
      // best effort: memory still holds it
    }
  }
}
