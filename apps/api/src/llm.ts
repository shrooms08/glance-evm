/**
 * Optional Claude lookup for company names the dictionary didn't know, used only when ANTHROPIC_API_KEY is set. The
 * service works fully without it.
 *
 * Called once per glance (the user pressed Option+G or opened the panel on a page), never on a passive page load: the
 * extension sends every unresolved candidate name on the page in one request (POST /resolve/names), and they all go to
 * Claude in one call. Only names that look like company names are asked (proper nouns, not common words), at most
 * MAX_NAMES per call, deduplicated.
 *
 * Claude answers by index with catalog symbols only, so a hallucinated company cannot reach the extension. Every answer
 * is cached for 7 days per normalized name, "not listed" included (src/llmBudget.ts), and every call counts against the
 * resolver's own daily budget. When Claude can't be asked, uncached names answer null: the dictionary's result stands.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import type { CatalogText } from "./catalog.js";
import { logUsage, MAX_OUTPUT_TOKENS, normalizeName, type LlmBudget, type Log, type NameAnswer, type NameCache } from "./llmBudget.js";

/** Candidate names per glance: enough for a long article, small enough for one short call. */
export const MAX_NAMES = 40;

const LlmAnswer = z.object({
  listed: z.array(z.object({ index: z.number().int(), symbol: z.string() })),
});

export interface NameResolution {
  name: string;
  /** The catalog symbol, or null: not a listed company (or not asked, when Claude is off or over budget). */
  symbol: string | null;
  source: "cache" | "llm" | "none";
}

export interface LlmResolver {
  readonly model: string;
  /** Resolves candidate names with at most one Claude call. Names that don't look like companies are dropped. */
  resolveNames(names: readonly string[]): Promise<NameResolution[]>;
}

/** The part of the Anthropic client we use (so tests can stand in for it without the network). */
export interface MessagesClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Pick<Anthropic.Message, "content" | "usage" | "stop_reason">> };
}

export interface LlmResolverOptions {
  apiKey: string | undefined;
  model: string;
  catalog: readonly CatalogText[];
  budget: LlmBudget;
  cache: NameCache;
  log?: Log;
  client?: MessagesClient;
}

/** Words that start sentences, headings and bylines but never name a company on their own. */
const NOT_NAMES = new Set(
  (
    "a an and are as at be but by for from he her his how i if in is it its me my no not of on or our she so that the their them then there " +
    "these they this those to up us was we what when where which who why will with you your yes new more most " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september " +
    "october november december today yesterday tomorrow read share follow subscribe sign log login menu home news search " +
    "photo video getty images reuters ap bloomberg advertisement contact about privacy terms cookie cookies"
  ).split(" "),
);

/**
 * True when `name` could be a company name: 2 to 60 characters, at most 6 words, starting with a capital letter or a
 * digit, made of letters, digits and & . , ' - only, and not a common word or date.
 */
export function looksLikeCompanyName(name: string): boolean {
  const n = name.replace(/\s+/g, " ").trim();
  if (n.length < 2 || n.length > 60) return false;
  if (!/^[\p{Lu}\d][\p{L}\p{N}&.,'’\- ]*$/u.test(n)) return false;
  const words = n.split(" ");
  if (words.length > 6) return false;
  if (!/\p{L}/u.test(n)) return false;
  const norm = normalizeName(n);
  if (norm.length < 2 || NOT_NAMES.has(norm)) return false;
  return true;
}

/** Candidates worth asking about: company-like, deduplicated by normalized name, at most MAX_NAMES (first seen first). */
export function selectCandidates(names: readonly string[], max = MAX_NAMES): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/\s+/g, " ").trim();
    if (!looksLikeCompanyName(name)) continue;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

export function createLlmResolver(o: LlmResolverOptions): LlmResolver | null {
  if (!o.apiKey && !o.client) return null;
  const log = o.log ?? ((l: string) => console.log(l));
  const client: MessagesClient = o.client ?? new Anthropic({ apiKey: o.apiKey, timeout: 10_000, maxRetries: 0 });
  const companies = o.catalog.map((c) => `${c.symbol}: ${c.legalName}`).join("\n");
  const symbols = new Set(o.catalog.map((c) => c.symbol));
  const system =
    "You match names found on a web page to listed companies, for a stock-trading browser extension. You get a " +
    "numbered list of names. Report a name only when it clearly refers to one of the companies below (its name, a " +
    "brand or product line it owns, or its ticker). Never for a person, a place, an unrelated company or a common word. " +
    `Leave every other name out. If none match, return an empty list.\n\nCompanies:\n${companies}`;
  const tool = {
    name: "report_listed",
    description: "Report which numbered names refer to a catalog company (an empty list if none).",
    input_schema: {
      type: "object" as const,
      properties: {
        listed: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer", description: "The name's number in the list" },
              symbol: { type: "string", description: "Ticker of the catalog company it refers to" },
            },
            required: ["index", "symbol"],
          },
        },
      },
      required: ["listed"],
    },
  };

  return {
    model: o.model,
    async resolveNames(names: readonly string[]): Promise<NameResolution[]> {
      const candidates = selectCandidates(names);
      const out = new Map<string, NameResolution>();
      const ask: string[] = [];
      for (const name of candidates) {
        const hit = o.cache.get(name);
        if (hit !== undefined) out.set(name, { name, symbol: hit, source: "cache" });
        else ask.push(name);
      }
      // Everything cached, or the resolver's budget is used up (or Claude is paused): the dictionary's answer stands.
      if (ask.length > 0 && o.budget.tryAcquire("resolver")) {
        let response;
        try {
          response = await client.messages.create({
            model: o.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system,
            tools: [tool],
            tool_choice: { type: "tool", name: tool.name },
            messages: [{ role: "user", content: ask.map((n, i) => `${i + 1}. ${n}`).join("\n") }],
          });
        } catch (err) {
          o.budget.failed(err);
          response = null; // a failed call answers "not asked": nothing cached, so the next glance may ask again
        }
        if (response) {
          logUsage(log, "resolver", o.model, response.usage);
          const use = response.stop_reason === "refusal" ? undefined : response.content.find((b) => b.type === "tool_use");
          const parsed = LlmAnswer.safeParse(use && "input" in use ? use.input : null);
          if (parsed.success) {
            const bySymbol = new Map<number, string>();
            for (const { index, symbol } of parsed.data.listed) if (symbols.has(symbol) && index >= 1 && index <= ask.length) bySymbol.set(index - 1, symbol);
            // Every name asked gets an answer, "not listed" (null) included, and is never asked again for 7 days.
            const answers = ask.map((name, i): [string, NameAnswer] => [name, bySymbol.get(i) ?? null]);
            o.cache.setMany(answers);
            for (const [name, symbol] of answers) out.set(name, { name, symbol, source: "llm" });
          }
        }
      }
      return candidates.map((name) => out.get(name) ?? { name, symbol: null, source: "none" });
    },
  };
}
