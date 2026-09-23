/**
 * Optional LLM fallback for /resolve, used only when ANTHROPIC_API_KEY is set AND the dictionary found nothing.
 * The service works fully without it.
 *
 * Claude is asked which of the catalog companies the text refers to and the exact wording used. Its answer is never
 * trusted as-is: every quote must appear verbatim in the input (we compute the offsets ourselves), and only catalog
 * symbols are accepted, so a hallucinated match cannot reach the extension.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import type { CatalogText } from "./catalog.js";
import type { ResolvedMatch } from "./resolver.js";

const LlmAnswer = z.object({
  mentions: z.array(
    z.object({
      symbol: z.string().describe("Ticker of the catalog company referred to"),
      quote: z.string().describe("The exact words from the text that refer to it, copied verbatim"),
    }),
  ),
});

export interface LlmResolver {
  resolve(text: string): Promise<ResolvedMatch[]>;
}

export function createLlmResolver(apiKey: string | undefined, model: string, catalog: readonly CatalogText[]): LlmResolver | null {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, timeout: 10_000, maxRetries: 1 });
  const companies = catalog.map((c) => `${c.symbol}: ${c.legalName}`).join("\n");
  const system =
    "You identify which listed companies a piece of web text refers to, for a stock-trading browser extension. " +
    "Only report a company when the text clearly refers to the company itself (by name, product line, ticker, or an " +
    "unambiguous description such as 'the EV maker led by Elon Musk'). Do not report a company for a coincidental " +
    "word, a person, a place or a unit of measurement. Copy each quote exactly as it appears in the text. If nothing " +
    `refers to these companies, return an empty list.\n\nCompanies:\n${companies}`;

  return {
    async resolve(text: string): Promise<ResolvedMatch[]> {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: betaZodOutputFormat(LlmAnswer) },
        system,
        messages: [{ role: "user", content: text }],
      });
      if (response.stop_reason === "refusal" || !response.parsed_output) return [];

      const symbols = new Set(catalog.map((c) => c.symbol));
      const matches: ResolvedMatch[] = [];
      for (const { symbol, quote } of response.parsed_output.mentions) {
        if (!symbols.has(symbol) || quote.trim().length < 2) continue;
        const start = text.indexOf(quote);
        if (start < 0) continue; // not verbatim: drop it
        matches.push({
          symbol,
          text: quote,
          start,
          end: start + quote.length,
          alias: quote,
          kind: "name",
          source: "llm",
        });
      }
      return matches.sort((a, b) => a.start - b.start);
    },
  };
}
