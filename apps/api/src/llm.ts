/**
 * Optional LLM fallback for /resolve, used only when ANTHROPIC_API_KEY is set AND the dictionary found nothing.
 * The service works fully without it.
 *
 * Claude is asked which of the catalog companies the text refers to and the exact wording used. Its answer is never
 * trusted as-is: every quote must appear verbatim in the input (we compute the offsets ourselves), and only catalog
 * symbols are accepted, so a hallucinated match cannot reach the extension.
 *
 * Every call is budgeted (src/llmBudget.ts): answers are cached for 24h by normalized text (a "no company" answer
 * too), calls count against the daily limit, and a budget error pauses Claude. When Claude can't be asked, the answer
 * is the dictionary's: no matches, never an error.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import type { CatalogText } from "./catalog.js";
import { logUsage, MAX_OUTPUT_TOKENS, type CachedAnswer, type LlmBudget, type Log, type ResolverCache } from "./llmBudget.js";
import type { ResolvedMatch } from "./resolver.js";

const LlmAnswer = z.object({
  mentions: z.array(z.object({ symbol: z.string(), quote: z.string() })),
});

export interface LlmResolver {
  readonly model: string;
  resolve(text: string): Promise<ResolvedMatch[]>;
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
  cache: ResolverCache;
  log?: Log;
  client?: MessagesClient;
}

export function createLlmResolver(o: LlmResolverOptions): LlmResolver | null {
  if (!o.apiKey && !o.client) return null;
  const log = o.log ?? ((l: string) => console.log(l));
  const client: MessagesClient = o.client ?? new Anthropic({ apiKey: o.apiKey, timeout: 10_000, maxRetries: 0 });
  const companies = o.catalog.map((c) => `${c.symbol}: ${c.legalName}`).join("\n");
  const symbols = new Set(o.catalog.map((c) => c.symbol));
  const system =
    "You identify which listed companies a piece of web text refers to, for a stock-trading browser extension. " +
    "Only report a company when the text clearly refers to the company itself (by name, product line, ticker, or an " +
    "unambiguous description such as 'the EV maker led by Elon Musk'). Do not report a company for a coincidental " +
    "word, a person, a place or a unit of measurement. Copy each quote exactly as it appears in the text. If nothing " +
    `refers to these companies, return an empty list.\n\nCompanies:\n${companies}`;
  const tool = {
    name: "report_mentions",
    description: "Report the catalog companies the text refers to (an empty list if none).",
    input_schema: {
      type: "object" as const,
      properties: {
        mentions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              symbol: { type: "string", description: "Ticker of the catalog company referred to" },
              quote: { type: "string", description: "The exact words from the text that refer to it, copied verbatim" },
            },
            required: ["symbol", "quote"],
          },
        },
      },
      required: ["mentions"],
    },
  };

  const toMatches = (text: string, answer: CachedAnswer): ResolvedMatch[] => {
    const matches: ResolvedMatch[] = [];
    for (const { symbol, quote } of answer.mentions) {
      if (!symbols.has(symbol) || quote.trim().length < 2) continue;
      const start = text.indexOf(quote);
      if (start < 0) continue; // not verbatim: drop it
      matches.push({ symbol, text: quote, start, end: start + quote.length, alias: quote, kind: "name", source: "llm" });
    }
    return matches.sort((a, b) => a.start - b.start);
  };

  return {
    model: o.model,
    async resolve(text: string): Promise<ResolvedMatch[]> {
      const cached = o.cache.get(text);
      if (cached) return toMatches(text, cached); // never the same text to Claude twice in 24h
      if (!o.budget.tryAcquire()) return []; // daily limit or paused: the dictionary's answer stands

      let response;
      try {
        response = await client.messages.create({
          model: o.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          tools: [tool],
          tool_choice: { type: "tool", name: tool.name },
          messages: [{ role: "user", content: text }],
        });
      } catch (err) {
        o.budget.failed(err);
        throw err;
      }
      logUsage(log, "resolve", o.model, response.usage);
      if (response.stop_reason === "refusal") return [];
      const use = response.content.find((b) => b.type === "tool_use");
      const parsed = LlmAnswer.safeParse(use && "input" in use ? use.input : null);
      if (!parsed.success) return [];
      // Keep only catalog symbols, and cache the answer even when it's empty ("not a listed stock").
      const answer: CachedAnswer = { mentions: parsed.data.mentions.filter((m) => symbols.has(m.symbol)) };
      o.cache.set(text, answer);
      return toMatches(text, answer);
    },
  };
}
