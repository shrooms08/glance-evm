/**
 * GET /why/:symbol: why a stock moved, from the news, never advice.
 *
 *   news     Finnhub company news for the last 3 days (Stock Token -> US ticker via @glance/core/tickers). Cached 15
 *            minutes. If Finnhub is down: "News isn't available right now." and no error.
 *   move     From our own feed history (the stand-in feeds' PriceSet events) when we have it; otherwise Finnhub's quote
 *            (change since the previous close), labelled as such. When the market is closed it says the move is as of
 *            the last close.
 *   summary  Claude (Haiku, through the LLM budget) writes at most 2 sentences using ONLY the headlines given, citing
 *            them as [1], [2], hedged ("reports point to", "may reflect"), or "No clear news explains this move."
 *            Checked after generation: citations must point at real headlines, and any advice or prediction phrase
 *            (@glance/core/tone) discards it, leaving the headlines alone. Cached 3 hours per symbol.
 *            At the daily limit, or if Claude fails: the top 3 headlines, no summary, no error.
 */
import { AS_OF_LAST_CLOSE, containsAdvice, NEWS_UNAVAILABLE, NO_CLEAR_NEWS, NO_RECENT_NEWS, TONE_RULES } from "@glance/core/tone";
import { formatSignedPercent } from "@glance/core/format";
import { PERSONA } from "@glance/core/persona";
import { usTicker } from "@glance/core/tickers";
import Anthropic from "@anthropic-ai/sdk";
import { anthropicFetch } from "./anthropicHttp.js";

import type { MessagesClient } from "./llm.js";
import { logUsage, MAX_OUTPUT_TOKENS, type LlmBudget, type Log } from "./llmBudget.js";
import { TtlCache } from "./ttlCache.js";

export const NEWS_TTL_MS = 15 * 60 * 1000;
export const SUMMARY_TTL_MS = 3 * 60 * 60 * 1000;
export const NEWS_WINDOW_DAYS = 3;
const MAX_HEADLINES = 8;
const FALLBACK_HEADLINES = 3;

export interface NewsArticle {
  headline: string;
  url: string;
  source: string;
  datetime: number; // unix seconds
}

export interface Quote {
  c: number; // current
  pc: number; // previous close
  dp: number | null; // percent change
  t: number; // unix seconds
}

// ---------------------------------------------------------------------------------------------------------------------
// Finnhub (15-minute cache; the key never leaves this module, never logged)
// ---------------------------------------------------------------------------------------------------------------------

export interface NewsClient {
  companyNews(ticker: string, from: string, to: string): Promise<NewsArticle[]>;
  quote(ticker: string): Promise<Quote>;
}

export function createFinnhub(opts: { apiKey: string; fetch?: typeof fetch; cache: TtlCache<unknown> }): NewsClient {
  const doFetch = opts.fetch ?? fetch;
  const get = async <T>(key: string, path: string): Promise<T> => {
    const hit = opts.cache.get(key);
    if (hit) return hit.value as T;
    let res: Response;
    try {
      res = await doFetch(`https://finnhub.io/api/v1${path}&token=${encodeURIComponent(opts.apiKey)}`, { signal: AbortSignal.timeout(6_000) });
    } catch {
      throw new Error("Finnhub unreachable"); // never the URL: it carries the key
    }
    if (!res.ok) throw new Error(`Finnhub answered ${res.status}`);
    const body = (await res.json()) as T;
    opts.cache.set(key, body);
    return body;
  };
  return {
    async companyNews(ticker, from, to) {
      const body = await get<unknown>(`news:${ticker}:${from}:${to}`, `/company-news?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}`);
      if (!Array.isArray(body)) throw new Error("Finnhub news: unexpected answer");
      return body
        .filter((a): a is NewsArticle => typeof a?.headline === "string" && typeof a?.url === "string" && a.headline.trim().length > 0)
        .map((a) => ({ headline: a.headline.trim(), url: a.url, source: String(a.source ?? ""), datetime: Number(a.datetime ?? 0) }));
    },
    async quote(ticker) {
      const q = await get<Quote>(`quote:${ticker}`, `/quote?symbol=${encodeURIComponent(ticker)}`);
      if (typeof q?.c !== "number" || typeof q?.pc !== "number" || q.c === 0) throw new Error("Finnhub quote: unexpected answer");
      return q;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The summary (Claude, budgeted) and its checks
// ---------------------------------------------------------------------------------------------------------------------

export interface SummaryInput {
  symbol: string;
  name: string;
  moveText: string | null;
  headlines: Array<{ title: string; site: string; publishedAt: string }>;
}

export interface Summarizer {
  readonly model: string;
  /** The summary text, or null when Claude can't be asked (daily limit, paused, failed). Never throws. */
  summarize(input: SummaryInput): Promise<string | null>;
}

export function createWhySummarizer(o: { apiKey?: string; model: string; budget: LlmBudget; log?: Log; client?: MessagesClient }): Summarizer | null {
  if (!o.apiKey && !o.client) return null;
  const log = o.log ?? ((l: string) => console.log(l));
  const client: MessagesClient = o.client ?? new Anthropic({ apiKey: o.apiKey, timeout: 10_000, maxRetries: 0, fetch: anthropicFetch });
  const system = [
    PERSONA,
    "",
    "Task: explain, in at most 2 short sentences, why a stock may have moved.",
    "Use ONLY the numbered headlines provided. Do not use anything else you know.",
    "Cite each claim with the headline's number in square brackets, like [1] or [2].",
    'Use hedged wording, such as "reports point to" or "may reflect". Never state a cause as certain.',
    `If the headlines don't explain the move, answer exactly: "${NO_CLEAR_NEWS}"`,
    ...TONE_RULES,
  ].join("\n");
  const tool = {
    name: "write_summary",
    description: "Record the summary.",
    input_schema: { type: "object" as const, properties: { summary: { type: "string" } }, required: ["summary"] },
  };
  return {
    model: o.model,
    async summarize(input) {
      if (!o.budget.tryAcquire("why")) return null;
      const numbered = input.headlines.map((h, i) => `[${i + 1}] ${h.title} (${h.site}, ${h.publishedAt.slice(0, 10)})`).join("\n");
      let response;
      try {
        response = await client.messages.create({
          model: o.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          tools: [tool],
          tool_choice: { type: "tool", name: tool.name },
          messages: [{ role: "user", content: `${input.name} (${input.symbol}). ${input.moveText ?? "Price change unknown."}\n\nHeadlines:\n${numbered}` }],
        });
      } catch (err) {
        o.budget.failed(err);
        return null;
      }
      logUsage(log, "why", o.model, response.usage);
      const use = response.content.find((b) => b.type === "tool_use");
      const summary = use && "input" in use ? (use.input as { summary?: unknown }).summary : null;
      return typeof summary === "string" && summary.trim() ? summary.trim() : null;
    },
  };
}

/** At most `n` sentences. */
export function firstSentences(text: string, n = 2): string {
  const parts = text.match(/[^.!?]+[.!?]+(?:\s*\[\d+\](?:\s*\[\d+\])*)?[.!?]?|[^.!?]+$/g) ?? [text];
  return parts.slice(0, n).join(" ").replace(/\s+/g, " ").trim();
}

export type SummaryCheck = { ok: true; text: string } | { ok: false; reason: "advice" | "citations" | "empty" };

/**
 * A generated summary is kept only if it gives no advice or prediction, cites at least one of the given headlines,
 * and cites nothing else. "No clear news explains this move." is always fine.
 */
export function checkSummary(raw: string, headlineCount: number): SummaryCheck {
  const text = firstSentences(raw.trim(), 2);
  if (!text) return { ok: false, reason: "empty" };
  if (containsAdvice(raw)) return { ok: false, reason: "advice" };
  if (text.replace(/\s+/g, " ") === NO_CLEAR_NEWS) return { ok: true, text: NO_CLEAR_NEWS };
  const cited = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  if (cited.length === 0 || cited.some((n) => n < 1 || n > headlineCount)) return { ok: false, reason: "citations" };
  return { ok: true, text };
}

// ---------------------------------------------------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------------------------------------------------

export interface Move {
  pct: string | null;
  from: string;
  to: string;
  window: string;
  /** Where the numbers come from, said plainly. */
  source: "glance-feed" | "finnhub-quote";
  label: string;
  /** Set when the market is closed. */
  note?: string;
}

export interface WhySource {
  title: string;
  url: string;
  site: string;
  publishedAt: string;
}

export interface WhyAnswer {
  symbol: string;
  move: Move | null;
  summary: string | null;
  /** Why there's no summary, when there isn't one. */
  summaryNote?: "llm-unavailable" | "guarded" | "no-news" | "news-unavailable";
  sources: WhySource[];
  generatedAt: string;
  cached: boolean;
}

export interface FeedMove {
  fromPrice: bigint;
  toPrice: bigint;
  decimals: number;
  fromAt: number;
  toAt: number;
  marketState: "OPEN" | "CLOSED" | "STALE";
}

export interface WhyDeps {
  news: NewsClient | null;
  summarizer: Summarizer | null;
  summaries: TtlCache<Omit<WhyAnswer, "cached">>;
  /** The move from our own feed history, or null if we don't have enough of it. */
  feedMove(symbol: string): Promise<FeedMove | null>;
  now(): number; // ms
  log?: Log;
}

const usd = (raw: bigint, decimals: number) => {
  const cents = (raw * 100n + 10n ** BigInt(decimals) / 2n) / 10n ** BigInt(decimals);
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};

function hours(seconds: number): string {
  const h = Math.max(1, Math.round(seconds / 3600));
  return h >= 48 ? `${Math.round(h / 24)} days` : `${h} ${h === 1 ? "hour" : "hours"}`;
}

export async function explainMove(deps: WhyDeps, stock: { symbol: string; name: string }): Promise<WhyAnswer> {
  const symbol = stock.symbol;
  const hit = deps.summaries.get(symbol);
  if (hit) return { ...hit.value, cached: true };

  const nowMs = deps.now();
  const generatedAt = new Date(nowMs).toISOString();
  const ticker = usTicker(symbol) ?? symbol;

  // The move: our own feed history first; Finnhub's quote otherwise, labelled.
  let move: Move | null = null;
  const fm = await deps.feedMove(symbol).catch(() => null);
  if (fm && fm.toAt > fm.fromAt) {
    move = {
      pct: formatSignedPercent(fm.toPrice - fm.fromPrice, fm.fromPrice),
      from: usd(fm.fromPrice, fm.decimals),
      to: usd(fm.toPrice, fm.decimals),
      window: `over ${hours(fm.toAt - fm.fromAt)}`,
      source: "glance-feed",
      label: "From Glance's price feed",
      ...(fm.marketState !== "OPEN" ? { note: AS_OF_LAST_CLOSE } : {}),
    };
  } else if (deps.news) {
    try {
      const q = await deps.news.quote(ticker);
      const toCents = BigInt(Math.round(q.c * 100));
      const fromCents = BigInt(Math.round(q.pc * 100));
      move = {
        pct: formatSignedPercent(toCents - fromCents, fromCents),
        from: usd(fromCents, 2),
        to: usd(toCents, 2),
        window: "since the previous close",
        source: "finnhub-quote",
        label: "Finnhub quote (change since the previous close)",
        ...(fm && fm.marketState !== "OPEN" ? { note: AS_OF_LAST_CLOSE } : {}),
      };
    } catch {
      move = null;
    }
  }

  if (!deps.news) {
    return { symbol, move, summary: NEWS_UNAVAILABLE, summaryNote: "news-unavailable", sources: [], generatedAt, cached: false };
  }
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  let articles: NewsArticle[];
  try {
    articles = await deps.news.companyNews(ticker, day(nowMs - NEWS_WINDOW_DAYS * 86_400_000), day(nowMs));
  } catch {
    return { symbol, move, summary: NEWS_UNAVAILABLE, summaryNote: "news-unavailable", sources: [], generatedAt, cached: false };
  }

  const seen = new Set<string>();
  const sources: WhySource[] = articles
    .filter((a) => !seen.has(a.headline.toLowerCase()) && (seen.add(a.headline.toLowerCase()), true))
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, MAX_HEADLINES)
    .map((a) => ({ title: a.headline, url: a.url, site: a.source, publishedAt: new Date(a.datetime * 1000).toISOString() }));

  if (sources.length === 0) {
    const answer = { symbol, move, summary: NO_RECENT_NEWS, summaryNote: "no-news" as const, sources, generatedAt };
    deps.summaries.set(symbol, answer);
    return { ...answer, cached: false };
  }

  const moveText = move?.pct ? `It moved ${move.pct} ${move.window} (${move.from} to ${move.to}).` : null;
  const raw = deps.summarizer ? await deps.summarizer.summarize({ symbol, name: stock.name, moveText, headlines: sources }) : null;
  if (raw === null) {
    // Daily limit, paused or failed: the headlines alone, not cached (Claude can be asked again later).
    return { symbol, move, summary: null, summaryNote: "llm-unavailable", sources: sources.slice(0, FALLBACK_HEADLINES), generatedAt, cached: false };
  }
  const checked = checkSummary(raw, sources.length);
  const answer: Omit<WhyAnswer, "cached"> = checked.ok
    ? { symbol, move, summary: checked.text, sources, generatedAt }
    : { symbol, move, summary: null, summaryNote: "guarded", sources: sources.slice(0, FALLBACK_HEADLINES), generatedAt };
  if (!checked.ok) deps.log?.(`[why] ${symbol} summary discarded (${checked.reason}); headlines only`);
  deps.summaries.set(symbol, answer); // Claude was asked either way: don't ask again for 3 hours
  return { ...answer, cached: false };
}

/** The summary as spoken: citation marks removed. */
export function spokenSummary(a: WhyAnswer, name: string): string {
  if (a.summary) return a.summary.replace(/\s*\[\d+\]/g, "").replace(/\s+([.,])/g, "$1").trim();
  if (a.sources.length) return `Here are the latest headlines about ${name}.`;
  return NEWS_UNAVAILABLE;
}
