/**
 * Every Claude call the API makes goes through here, so the Anthropic bill stays small and predictable:
 *
 *   models   claude-haiku-4-5 by default for everything. A model name containing "opus" is refused at startup (one
 *            warning line, Haiku used instead) unless ALLOW_OPUS=1.
 *   cap      LLM_DAILY_CALL_LIMIT calls per UTC day across the whole API (default 150), counted before each call is
 *            sent and persisted, so a restart doesn't reset it. At the limit, callers use the dictionary resolver and
 *            the rules intent parser: the user never sees an error.
 *   pause    An Anthropic 401, 402 or 429, or a "credit balance" error, pauses Claude for an hour (same fallback).
 *   cache    /resolve answers are cached for 24 hours by normalized text, including "no listed company" answers, in
 *            memory and in RESOLVER_CACHE_FILE, so the same text is never sent twice in a day, even across restarts.
 *            Keys are SHA-256 hashes: page text is never written to disk.
 *   logs     One line per call: purpose, model, input and output tokens. Never the key, the prompt, page text or audio.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HAIKU = "claude-haiku-4-5";
/** Small answers only: the resolver's JSON and the intent's tool call both fit well within this. */
export const MAX_OUTPUT_TOKENS = 256;
export const PAUSE_MS = 60 * 60 * 1000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type Log = (line: string) => void;

/** The model to use for `purpose`: `requested`, unless it's an Opus model and ALLOW_OPUS isn't set. */
export function chooseModel(requested: string | undefined, allowOpus: boolean, purpose: string, log: Log): string {
  const name = requested?.trim() || HAIKU;
  if (/opus/i.test(name) && !allowOpus) {
    log(`  llm warning: ${purpose} model "${name}" refused (Opus is blocked to protect the budget; set ALLOW_OPUS=1 to allow it). Using ${HAIKU}.`);
    return HAIKU;
  }
  return name;
}

/** True for errors that mean "stop spending": no key, no credit, or rate limited. */
export function isBudgetError(err: unknown): boolean {
  const e = err as { status?: unknown; message?: unknown; error?: { error?: { message?: unknown } } } | null;
  if (!e) return false;
  if (e.status === 401 || e.status === 402 || e.status === 429) return true;
  const text = `${String(e.message ?? "")} ${String(e.error?.error?.message ?? "")}`;
  return /credit balance/i.test(text);
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface UsageFile {
  day: string;
  used: number;
  pausedUntil: number;
}

export interface BudgetStatus {
  dailyLimit: number;
  usedToday: number;
  paused: boolean;
  pausedUntil: string | null;
}

/** The daily call counter and the pause switch, shared by every Claude caller. */
export class LlmBudget {
  private usage: UsageFile;
  private announcedLimitFor: string | null = null;
  private announcedPauseUntil = 0;

  constructor(
    readonly dailyLimit: number,
    private readonly file: string | null,
    private readonly log: Log = (l) => console.log(l),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.usage = { day: utcDay(this.now()), used: 0, pausedUntil: 0 };
    if (file) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<UsageFile>;
        this.usage = { day: String(saved.day ?? this.usage.day), used: Number(saved.used ?? 0), pausedUntil: Number(saved.pausedUntil ?? 0) };
      } catch {
        // no file yet, or unreadable: start from zero
      }
    }
    this.rollOver();
  }

  private rollOver() {
    const today = utcDay(this.now());
    if (this.usage.day !== today) this.usage = { ...this.usage, day: today, used: 0 };
  }

  private save() {
    if (!this.file) return;
    writeJsonAtomic(this.file, this.usage);
  }

  /**
   * Counts one call and returns true if it may be sent; false (with one log line per day or per pause) when the daily
   * limit is reached or Claude is paused. Callers then use the dictionary or the rules.
   */
  tryAcquire(): boolean {
    this.rollOver();
    const now = this.now();
    if (now < this.usage.pausedUntil) {
      if (this.announcedPauseUntil !== this.usage.pausedUntil) {
        this.announcedPauseUntil = this.usage.pausedUntil;
        this.log(`[llm] paused until ${new Date(this.usage.pausedUntil).toISOString()}, using rules`);
      }
      return false;
    }
    if (this.usage.used >= this.dailyLimit) {
      if (this.announcedLimitFor !== this.usage.day) {
        this.announcedLimitFor = this.usage.day;
        this.log("[llm] LLM daily limit reached, using rules");
      }
      return false;
    }
    this.usage.used += 1;
    this.save();
    return true;
  }

  /** After a failed call: a budget error pauses Claude for an hour. Returns whether it paused. */
  failed(err: unknown): boolean {
    if (!isBudgetError(err)) return false;
    this.usage.pausedUntil = this.now() + PAUSE_MS;
    this.save();
    const status = (err as { status?: number }).status;
    this.log(`[llm] Anthropic refused (${status ?? "credit balance"}): pausing Claude for 1 hour, using rules`);
    this.announcedPauseUntil = this.usage.pausedUntil;
    return true;
  }

  status(): BudgetStatus {
    this.rollOver();
    const paused = this.now() < this.usage.pausedUntil;
    return {
      dailyLimit: this.dailyLimit,
      usedToday: this.usage.used,
      paused,
      pausedUntil: paused ? new Date(this.usage.pausedUntil).toISOString() : null,
    };
  }
}

/** One line per Claude call: what for, which model, tokens in and out. Nothing else. */
export function logUsage(log: Log, purpose: string, model: string, usage: { input_tokens?: number; output_tokens?: number } | undefined) {
  log(`[llm] ${purpose} ${model} in=${usage?.input_tokens ?? "?"} out=${usage?.output_tokens ?? "?"}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Resolver cache
// ---------------------------------------------------------------------------------------------------------------------

/** What Claude said about a text: the catalog mentions (symbol and the exact quote); empty means "no listed company". */
export interface CachedAnswer {
  mentions: Array<{ symbol: string; quote: string }>;
}

interface CacheFile {
  entries: Record<string, { at: number; mentions: Array<{ symbol: string; quote: string }> }>;
}

/** Lowercase, whitespace collapsed, trimmed: "  Tesla\n Inc " and "tesla inc" are the same question. */
export function normalizeForCache(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export class ResolverCache {
  private entries: CacheFile["entries"] = {};

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = () => Date.now(),
    private readonly max = 5_000,
  ) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheFile>;
      this.entries = saved.entries ?? {};
      this.prune();
    } catch {
      this.entries = {};
    }
  }

  private key(text: string): string {
    return createHash("sha256").update(normalizeForCache(text)).digest("hex");
  }

  private prune() {
    const cutoff = this.now() - CACHE_TTL_MS;
    for (const [k, v] of Object.entries(this.entries)) if (v.at <= cutoff) delete this.entries[k];
    const keys = Object.keys(this.entries);
    if (keys.length > this.max) {
      keys
        .sort((a, b) => this.entries[a]!.at - this.entries[b]!.at)
        .slice(0, keys.length - this.max)
        .forEach((k) => delete this.entries[k]);
    }
  }

  get(text: string): CachedAnswer | null {
    const hit = this.entries[this.key(text)];
    if (!hit || hit.at <= this.now() - CACHE_TTL_MS) return null;
    return { mentions: hit.mentions };
  }

  set(text: string, answer: CachedAnswer) {
    this.entries[this.key(text)] = { at: this.now(), mentions: answer.mentions };
    this.prune();
    if (this.file) writeJsonAtomic(this.file, { entries: this.entries } satisfies CacheFile);
  }

  get size(): number {
    return Object.keys(this.entries).length;
  }
}

function writeJsonAtomic(file: string, value: unknown) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.${Date.now()}-${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  } catch {
    // Best effort: a read-only disk must never break a request (the in-memory state still applies).
  }
}
