/**
 * Finds companies in free text and maps them to catalog entries, with UTF-16 offsets (JavaScript string indices) so
 * the extension can underline them with the DOM Range API.
 *
 * Matching rules, chosen so ordinary prose does not light up:
 *  - Company names match case-insensitively, on word boundaries: "Tesla's" matches, "Teslas" and "Amazonian" do not.
 *  - Tickers match only when written in capitals ("TSLA") or as a cashtag ("$TSLA", "$tsla"), so "amd" and "aws" in
 *    running text do not.
 *  - A match inside an excluded phrase ("Nikola Tesla", "Amazon rainforest") or near an excluded word ("macular" for
 *    AMD) is dropped.
 *  - Overlapping matches resolve to the longest ("Palantir Technologies" beats "Palantir").
 */
import type { CatalogText } from "./catalog.js";

export interface ResolvedMatch {
  symbol: string;
  /** The exact text matched, as it appears in the input. */
  text: string;
  /** Start offset (inclusive), in UTF-16 code units. */
  start: number;
  /** End offset (exclusive), in UTF-16 code units. */
  end: number;
  alias: string;
  kind: "name" | "ticker" | "cashtag";
  source: "dictionary" | "llm";
}

const NEAR_WINDOW = 80;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Letters, digits and underscore on either side mean we are inside a larger word.
const BEFORE = "(?<![\\p{L}\\p{N}_$])";
const AFTER = "(?![\\p{L}\\p{N}_])";

interface Pattern {
  symbol: string;
  alias: string;
  kind: ResolvedMatch["kind"];
  regex: RegExp;
  excludePhrases: RegExp[];
  excludeNear: RegExp[];
}

export class Resolver {
  private readonly patterns: Pattern[];

  constructor(catalog: readonly CatalogText[]) {
    this.patterns = catalog.flatMap((stock) => {
      const excludePhrases = stock.excludePhrases.map((p) => new RegExp(escape(p), "giu"));
      const excludeNear = stock.excludeNear.map((w) => new RegExp(`${BEFORE}${escape(w)}`, "iu"));
      const common = { symbol: stock.symbol, excludePhrases, excludeNear };
      return [
        ...stock.names.map((name) => ({
          ...common,
          alias: name,
          kind: "name" as const,
          // A name ending in punctuation ("Tesla, Inc.") must not require a word boundary after it.
          regex: new RegExp(`${BEFORE}${escape(name)}${/[\p{L}\p{N}]$/u.test(name) ? AFTER : ""}`, "giu"),
        })),
        ...stock.tickers.map((ticker) => ({
          ...common,
          alias: `$${ticker}`,
          kind: "cashtag" as const,
          regex: new RegExp(`(?<![\\p{L}\\p{N}_])\\$${escape(ticker)}${AFTER}`, "giu"),
        })),
        ...stock.tickers.map((ticker) => ({
          ...common,
          alias: ticker,
          kind: "ticker" as const,
          regex: new RegExp(`${BEFORE}${escape(ticker)}${AFTER}`, "gu"), // case-sensitive
        })),
      ];
    });
  }

  /** All catalog companies mentioned in `text`, in order of appearance, without overlaps. */
  resolve(text: string): ResolvedMatch[] {
    const found: ResolvedMatch[] = [];
    for (const p of this.patterns) {
      for (const m of text.matchAll(p.regex)) {
        const start = m.index;
        const end = start + m[0].length;
        if (this.excluded(text, start, end, p)) continue;
        found.push({ symbol: p.symbol, text: m[0], start, end, alias: p.alias, kind: p.kind, source: "dictionary" });
      }
    }
    // Longest first, then earliest, keep non-overlapping.
    found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    const kept: ResolvedMatch[] = [];
    for (const m of found) {
      if (!kept.some((k) => m.start < k.end && k.start < m.end)) kept.push(m);
    }
    return kept.sort((a, b) => a.start - b.start);
  }

  private excluded(text: string, start: number, end: number, p: Pattern): boolean {
    for (const phrase of p.excludePhrases) {
      for (const m of text.matchAll(phrase)) {
        if (m.index <= start && m.index + m[0].length >= end) return true;
      }
    }
    if (p.excludeNear.length > 0) {
      const around = text.slice(Math.max(0, start - NEAR_WINDOW), Math.min(text.length, end + NEAR_WINDOW));
      if (p.excludeNear.some((w) => w.test(around))) return true;
    }
    return false;
  }
}
