/**
 * Every Claude call the API makes goes through here, so the Anthropic bill stays small and predictable:
 *
 *   models   claude-haiku-4-5 by default for everything. A model name containing "opus" is refused at startup (one
 *            warning line, Haiku used instead) unless ALLOW_OPUS=1.
 *   cap      LLM_DAILY_CALL_LIMIT calls per UTC day across the whole API (default 250), and under it a budget per
 *            purpose (LLM_BUDGET_RESOLVER 40, LLM_BUDGET_INTENT 80, LLM_BUDGET_WHY 60, LLM_BUDGET_OTHER 70). Each call
 *            is counted, with its purpose, before it's sent, and persisted, so a restart doesn't reset it. When one
 *            purpose runs out only that purpose falls back (resolver to the dictionary, intent to the rules, why to
 *            headlines only); the others keep working. The user never sees an error.
 *   pause    An Anthropic 401, 402 or 429, or a "credit balance" error, pauses Claude for an hour (same fallbacks).
 *   cache    Company lookups are cached for 7 days per candidate name, including "not listed" answers, in memory and
 *            in RESOLVER_CACHE_FILE, so the same name never costs twice, even across restarts. Keys are SHA-256
 *            hashes: nothing from a page is written to disk as text.
 *   logs     One line per call: purpose, model, input and output tokens. Never the key, the prompt, page text or audio.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HAIKU = "claude-haiku-4-5";
/** Small answers only: the resolver's JSON and the intent's tool call both fit well within this. */
export const MAX_OUTPUT_TOKENS = 256;
export const PAUSE_MS = 60 * 60 * 1000;
export const NAME_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

/** What a Claude call is for. Each has its own daily budget under the total; "other" is kept for new features. */
export const PURPOSES = ["resolver", "intent", "why", "other"] as const;
export type Purpose = (typeof PURPOSES)[number];

export interface BudgetLimits {
  /** Every purpose together (LLM_DAILY_CALL_LIMIT). */
  total: number;
  perPurpose: Record<Purpose, number>;
}

const zeroes = (): Record<Purpose, number> => ({ resolver: 0, intent: 0, why: 0, other: 0 });

interface UsageFile {
  day: string;
  /** Every call today, whatever it was for (older files only have this). */
  used: number;
  byPurpose: Record<Purpose, number>;
  pausedUntil: number;
}

export interface BudgetStatus {
  dailyLimit: number;
  usedToday: number;
  byPurpose: Record<Purpose, { used: number; limit: number }>;
  paused: boolean;
  pausedUntil: string | null;
}

/**
 * The daily call counters and the pause switch, shared by every Claude caller. Each call names its purpose and counts
 * against that purpose's budget and the total; when a purpose runs out only that purpose falls back.
 */
export class LlmBudget {
  readonly limits: BudgetLimits;
  private usage: UsageFile;
  private announcedLimit = new Set<string>();
  private announcedPauseUntil = 0;

  constructor(
    limits: number | BudgetLimits,
    private readonly file: string | null,
    private readonly log: Log = (l) => console.log(l),
    private readonly now: () => number = () => Date.now(),
  ) {
    // A bare number is a total with no per-purpose split (every purpose may use all of it).
    this.limits = typeof limits === "number" ? { total: limits, perPurpose: { resolver: limits, intent: limits, why: limits, other: limits } } : limits;
    this.usage = { day: utcDay(this.now()), used: 0, byPurpose: zeroes(), pausedUntil: 0 };
    if (file) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<UsageFile>;
        const byPurpose = zeroes();
        for (const p of PURPOSES) byPurpose[p] = Number(saved.byPurpose?.[p] ?? 0);
        this.usage = { day: String(saved.day ?? this.usage.day), used: Number(saved.used ?? 0), byPurpose, pausedUntil: Number(saved.pausedUntil ?? 0) };
      } catch {
        // no file yet, or unreadable: start from zero
      }
    }
    this.rollOver();
  }

  get dailyLimit(): number {
    return this.limits.total;
  }

  private rollOver() {
    const today = utcDay(this.now());
    if (this.usage.day !== today) this.usage = { ...this.usage, day: today, used: 0, byPurpose: zeroes() };
  }

  private save() {
    if (!this.file) return;
    writeJsonAtomic(this.file, this.usage);
  }

  private announce(key: string, line: string) {
    const k = `${this.usage.day}:${key}`;
    if (this.announcedLimit.has(k)) return;
    this.announcedLimit.add(k);
    this.log(line);
  }

  /**
   * Counts one call for `purpose` and returns true if it may be sent; false (with one log line per day, per purpose, or
   * per pause) when that purpose's budget or the total is used up, or Claude is paused. Callers then use their fallback:
   * the dictionary, the rules, or headlines only.
   */
  tryAcquire(purpose: Purpose = "other"): boolean {
    this.rollOver();
    const now = this.now();
    if (now < this.usage.pausedUntil) {
      if (this.announcedPauseUntil !== this.usage.pausedUntil) {
        this.announcedPauseUntil = this.usage.pausedUntil;
        this.log(`[llm] paused until ${new Date(this.usage.pausedUntil).toISOString()}, using rules`);
      }
      return false;
    }
    if (this.usage.used >= this.limits.total) {
      this.announce("total", "[llm] LLM daily limit reached, using rules");
      return false;
    }
    if (this.usage.byPurpose[purpose] >= this.limits.perPurpose[purpose]) {
      this.announce(purpose, `[llm] ${purpose} budget reached (${this.limits.perPurpose[purpose]} today), ${FALLBACK[purpose]}`);
      return false;
    }
    this.usage.used += 1;
    this.usage.byPurpose[purpose] += 1;
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
    const byPurpose = {} as BudgetStatus["byPurpose"];
    for (const p of PURPOSES) byPurpose[p] = { used: this.usage.byPurpose[p], limit: this.limits.perPurpose[p] };
    return {
      dailyLimit: this.limits.total,
      usedToday: this.usage.used,
      byPurpose,
      paused,
      pausedUntil: paused ? new Date(this.usage.pausedUntil).toISOString() : null,
    };
  }
}

/** What each purpose falls back to when its budget is used up. */
const FALLBACK: Record<Purpose, string> = {
  resolver: "using the dictionary",
  intent: "using rules",
  why: "headlines only",
  other: "skipped",
};

/** One line per Claude call: what for, which model, tokens in and out. Nothing else. */
export function logUsage(log: Log, purpose: string, model: string, usage: { input_tokens?: number; output_tokens?: number } | undefined) {
  log(`[llm] ${purpose} ${model} in=${usage?.input_tokens ?? "?"} out=${usage?.output_tokens ?? "?"}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Company-name cache
// ---------------------------------------------------------------------------------------------------------------------

/** What Claude said about one candidate name: a catalog symbol, or null for "not a listed company". */
export type NameAnswer = string | null;

/**
 * "  The Tesla\n Inc's " and "tesla inc" are the same question: lowercase, whitespace collapsed, a leading "the", a
 * possessive and trailing punctuation dropped.
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "")
    .replace(/[\s.,;:!?]+$/, "")
    .replace(/['’]s$/, "")
    .trim();
}

interface NameCacheFile {
  entries: Record<string, { at: number; symbol: NameAnswer }>;
}

/**
 * Claude's answer per candidate name, "not listed" included, for 7 days, in memory and in a file under the gitignored
 * .cache dir, so the same name never costs twice (restarts included). Keys are SHA-256 hashes of the normalized name.
 */
export class NameCache {
  private entries: NameCacheFile["entries"] = {};

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = () => Date.now(),
    private readonly max = 20_000,
  ) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<NameCacheFile>;
      this.entries = saved.entries ?? {};
      this.prune();
    } catch {
      this.entries = {};
    }
  }

  private key(name: string): string {
    return createHash("sha256").update(normalizeName(name)).digest("hex");
  }

  private prune() {
    const cutoff = this.now() - NAME_CACHE_TTL_MS;
    for (const [k, v] of Object.entries(this.entries)) if (v.at <= cutoff) delete this.entries[k];
    const keys = Object.keys(this.entries);
    if (keys.length > this.max) {
      keys
        .sort((a, b) => this.entries[a]!.at - this.entries[b]!.at)
        .slice(0, keys.length - this.max)
        .forEach((k) => delete this.entries[k]);
    }
  }

  /** The cached answer, or undefined when this name hasn't been asked in the last 7 days. */
  get(name: string): NameAnswer | undefined {
    const hit = this.entries[this.key(name)];
    if (!hit || hit.at <= this.now() - NAME_CACHE_TTL_MS) return undefined;
    return hit.symbol;
  }

  /** Stores several answers with one file write. */
  setMany(answers: ReadonlyArray<[name: string, symbol: NameAnswer]>) {
    const at = this.now();
    for (const [name, symbol] of answers) this.entries[this.key(name)] = { at, symbol };
    this.prune();
    if (this.file) writeJsonAtomic(this.file, { entries: this.entries } satisfies NameCacheFile);
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
