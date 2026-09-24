/**
 * Transcript -> intent. Claude reads the transcript when ANTHROPIC_API_KEY is set; a strict rules parser serves when
 * it isn't (or when Claude is slow or fails). Whichever produced it, every intent passes the same validator:
 *   - the symbol must be one of our catalog's, or it is dropped;
 *   - the amount must be one the user actually said (extractAmounts), or it is dropped: nothing invents an amount;
 *   - a negation, a question asking for advice, a past tense or a hypothetical never becomes a buy or a sell.
 * An intent is only ever a suggestion to the extension: a buy opens the same confirm card as the typed path, with the
 * same on-chain preflight and vault guards. Nothing here can trade.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import type { CatalogEntry } from "../catalog.js";
import type { MessagesClient } from "../llm.js";
import { logUsage, MAX_OUTPUT_TOKENS, type LlmBudget, type Log } from "../llmBudget.js";
import { extractAmounts } from "./amounts.js";

export const INTENTS = ["buy", "sell", "price", "spend-so-far", "explain", "portfolio", "why", "unknown"] as const;
export type IntentKind = (typeof INTENTS)[number];

export interface VoiceContext {
  /** The page's host, e.g. "cnbc.com". */
  host?: string;
  /** Companies Glance found on the page, most mentioned first. */
  companies?: Array<{ symbol: string; mentions: number }>;
  /** The last refusal from a vault guard, for "why?". */
  lastGuard?: { code: string; message: string } | null;
  /** The last thing Glance said. */
  lastReply?: string | null;
  /** The company card currently open, if any. */
  openCard?: string | null;
}

export interface Intent {
  intent: IntentKind;
  symbol: string | null;
  /** Whole-dollar or cent amount, only ever one the user said. */
  amount: string | null;
  /** Why the validator changed it, if it did (for logs and tests; never spoken). */
  note?: string;
  /** Claude's one-sentence reply for explain and unknown (spoken replies for data come from our own code). */
  modelReply?: string;
  source: "claude" | "rules";
}

// ---------------------------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------------------------

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9$.,'? -]/g, " ")
    .replace(/(?<![0-9])[.,]|[.,](?![0-9])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Phrasings that must never become a trade, whatever the verb: "don't buy Tesla", "should I buy Tesla?", "I bought
 * Tesla yesterday", "what if I sold Amazon", "remind me to buy Netflix tomorrow", "Tesla bought Twitter".
 */
export function blocksTrade(transcript: string): string | null {
  const t = ` ${normalise(transcript)} `;
  if (/ (don't|dont|do not|never|not|no longer|stop|cancel|won't|wont) /.test(t)) return "negation";
  if (/ (should i|should we|would it|is it a good|is now a good|good time to|worth buying|worth selling|do you think|would you) /.test(t)) {
    return "advice";
  }
  if (/ (what if|if i|suppose|imagine|hypothetically|thinking (of|about)|wondering|considering|maybe) /.test(t)) return "hypothetical";
  if (/ (bought|sold|purchased|was buying|was selling|yesterday|last week|last month|earlier) /.test(t)) return "past";
  if (/ (remind me|later|tomorrow|next week|at the open|when it|if it) /.test(t)) return "deferred";
  return null;
}

const LEAD = "(?:(?:ok|okay|hey|glance|please|so|um|uh|can you|could you|would you|i want to|i'd like to|id like to|i wanna|let's|lets|go ahead and)\\s+)*";

/** The first verb, only when it opens the request: "buy ...", "please sell ...", "I'd like to buy ...". */
function leadingVerb(t: string): "buy" | "sell" | null {
  const m = new RegExp(`^${LEAD}(buy|get|purchase|grab|pick up|sell|dump|unload)\\b`).exec(t);
  if (!m) return null;
  return ["sell", "dump", "unload"].includes(m[1]!) ? "sell" : "buy";
}

function aliasTable(catalog: readonly CatalogEntry[]): Array<{ phrase: string; symbol: string }> {
  const rows: Array<{ phrase: string; symbol: string }> = [];
  for (const c of catalog) {
    const phrases = new Set<string>();
    for (const a of [...c.aliases, c.name, c.legalName, c.symbol]) {
      const n = normalise(a.replace(/^\$/, "")).replace(/\?/g, "");
      if (n) phrases.add(n);
    }
    phrases.add(c.symbol.toLowerCase().split("").join(" ")); // "t s l a"
    for (const p of phrases) rows.push({ phrase: p, symbol: c.symbol });
  }
  return rows.sort((a, b) => b.phrase.length - a.phrase.length);
}

/** Every catalog company named in the text, in order of first mention. */
export function findCompanies(text: string, catalog: readonly CatalogEntry[]): string[] {
  const t = ` ${normalise(text).replace(/\?/g, " ")} `;
  const hits: Array<{ at: number; symbol: string }> = [];
  for (const row of aliasTable(catalog)) {
    const at = t.indexOf(` ${row.phrase} `);
    if (at >= 0 && !hits.some((h) => h.symbol === row.symbol)) hits.push({ at, symbol: row.symbol });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.symbol);
}

export function rulesIntent(transcript: string, catalog: readonly CatalogEntry[]): Intent {
  const t = normalise(transcript).replace(/\?/g, " ").trim();
  const companies = findCompanies(transcript, catalog);
  const symbol = companies.length === 1 ? companies[0]! : null;
  const amounts = extractAmounts(transcript);
  const base = { source: "rules" as const, symbol, amount: null };

  const verb = leadingVerb(t);
  if (verb) return { ...base, intent: verb, amount: amounts.length === 1 ? amounts[0]! : null };
  // A trade verb elsewhere ("don't buy Tesla", "should I sell Amazon?"): hand it to the validator, which refuses it as
  // a trade and records why, so the reply can answer what was actually asked.
  const anywhere = /\b(buy|buying|bought|purchase|purchased|sell|selling|sold)\b/.exec(t);
  if (anywhere && blocksTrade(transcript)) {
    return { ...base, intent: /sell|sold/.test(anywhere[1]!) ? "sell" : "buy", amount: amounts.length === 1 ? amounts[0]! : null };
  }

  if (/\b(spent|spend|spending)\b.*\b(today|so far)\b|how much (have i|did i) (spent|spend)|what have i spent|how much .*\bleft\b|how much can i (still )?(spend|buy)/.test(t)) {
    return { ...base, symbol: null, intent: "spend-so-far" };
  }
  if (/\bhow am i doing\b|\bwhat do i (own|have|hold)\b|\b(show|open|see)( me)? my (portfolio|positions|holdings|stocks)\b|^(my )?(portfolio|positions|holdings)$|\bhow('s| is) my (portfolio|vault) doing\b/.test(t)) {
    return { ...base, symbol: null, intent: "portfolio" };
  }
  // "why did Tesla move?", "why is AMD down?": a company and a movement word. (A bare "why?" explains a refusal.)
  if (symbol && /\bwhy\b|\bwhat (moved|happened to)\b/.test(t) && /\b(move|moved|moving|up|down|drop|dropped|dropping|jump|jumped|fall|fell|falling|rise|rose|rising|rally|rallied|slide|slid|surge|surged|plunge|plunged|spike|spiked|tank|tanked|climb|climbed)\b/.test(t)) {
    return { ...base, intent: "why" };
  }
  if (/^(why|explain|what happened|what does that mean|how come)\b|\bwhy (was|did|is|not|can't|cant)\b/.test(t)) {
    return { ...base, symbol: null, intent: "explain" };
  }
  if (
    symbol &&
    (/^(?:what's|whats|what is|how's|hows|how is|where's|where is)\b.*\b(at|trading|doing|going for|worth|price)\b/.test(t) ||
      /\b(price of|quote for|quote on|how much is|price for|share price|stock price|price)\b/.test(t))
  ) {
    return { ...base, intent: "price" };
  }
  return { ...base, symbol: null, intent: "unknown" };
}

// ---------------------------------------------------------------------------------------------------------------
// Validator: applied to every intent, whichever produced it
// ---------------------------------------------------------------------------------------------------------------

export function validateIntent(raw: Intent, transcript: string, catalog: readonly CatalogEntry[]): Intent {
  const symbols = new Set(catalog.map((c) => c.symbol));
  const out: Intent = { ...raw };
  const notes: string[] = [];

  if (!INTENTS.includes(out.intent)) {
    out.intent = "unknown";
    notes.push("unknown intent");
  }
  if (out.symbol !== null) {
    const s = out.symbol.toUpperCase().replace(/^\$/, "");
    if (symbols.has(s)) out.symbol = s;
    else {
      out.symbol = null;
      notes.push(`symbol ${raw.symbol} is not in the catalog`);
    }
  }
  // The only amounts allowed are the ones the user said.
  if (out.amount !== null) {
    const said = extractAmounts(transcript);
    const a = out.amount.replace(/^\$/, "").replace(/,/g, "");
    const match = said.find((s) => Number(s) === Number(a));
    if (match) out.amount = match;
    else {
      out.amount = null;
      notes.push(`amount ${raw.amount} was not said`);
    }
  }
  if (out.intent === "buy" || out.intent === "sell") {
    const block = blocksTrade(transcript);
    if (block) {
      notes.push(`not a trade request (${block})`);
      out.intent = out.symbol ? "price" : "unknown";
      out.amount = null;
      if (block !== "advice") out.intent = "unknown";
    }
  }
  if (out.intent === "why" && !out.symbol) {
    notes.push("why without a catalog company");
    out.intent = "explain";
  }
  if (out.intent === "portfolio") out.symbol = null;
  if ((out.intent === "buy" || out.intent === "sell" || out.intent === "price") && !out.symbol) {
    notes.push(`${out.intent} without a catalog company`);
    out.intent = "unknown";
    out.amount = null;
  }
  if (out.intent !== "buy" && out.intent !== "sell") out.amount = null;
  if (out.intent === "spend-so-far" || out.intent === "explain" || out.intent === "unknown") {
    if (out.intent !== "unknown") out.symbol = null;
  }
  if (notes.length) out.note = notes.join("; ");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------------------------------------------

const ClaudeIntent = z.object({
  intent: z.enum(INTENTS),
  symbol: z.string().nullable(),
  amount: z.string().nullable(),
  reply: z.string().max(240).nullable(),
});

export interface IntentModel {
  readonly model: string;
  classify(transcript: string, context: VoiceContext): Promise<Intent>;
}

export interface ClaudeIntentOptions {
  /** Counts the call against the daily limit and pauses on budget errors; without it, calls aren't budgeted. */
  budget?: LlmBudget;
  log?: Log;
  /** Stands in for the Anthropic client in tests. */
  client?: MessagesClient;
}

export function createClaudeIntent(
  apiKey: string | undefined,
  model: string,
  catalog: readonly CatalogEntry[],
  timeoutMs = 3_000,
  opts: ClaudeIntentOptions = {},
): IntentModel | null {
  if (!apiKey && !opts.client) return null;
  const log = opts.log ?? ((l: string) => console.log(l));
  const client: MessagesClient = opts.client ?? new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 });
  const companies = catalog.map((c) => `${c.symbol}: ${c.legalName} (also: ${[c.name, ...c.aliases].join(", ")})`).join("\n");
  const system = [
    "You turn one spoken command to a stock-buying browser assistant into a structured intent.",
    "Intents: buy, sell, price (the user wants a price), spend-so-far (how much they have spent or have left today),",
    "explain (they ask why something happened, e.g. why a trade was refused), portfolio (how they're doing, what they",
    "own, or to show their portfolio), why (why a named stock moved, e.g. \"why did Tesla move?\"; needs the symbol),",
    "unknown (anything else, or ambiguous).",
    "Rules:",
    "- symbol: ONLY a ticker from the list below, or null. Never any other ticker.",
    "- amount: ONLY a dollar amount the user explicitly said, as digits (\"ten dollars\" -> \"10\"). If they named no",
    "  amount, null. Never guess, round, suggest or default an amount.",
    "- Only an explicit request to act now is buy or sell. Negations (\"don't buy\"), advice questions (\"should I",
    "  buy\"), past events (\"I bought\", \"Tesla bought\"), hypotheticals and anything for later are NOT buy or sell.",
    "- If you are not sure, answer unknown.",
    "- reply: for explain and unknown only, one short, honest spoken sentence, using only facts given in the context",
    "  (never invent prices, numbers or reasons). For other intents, null.",
    "Companies:",
    companies,
  ].join("\n");
  const tool = {
    name: "record_intent",
    description: "Record the intent of the spoken command.",
    input_schema: {
      type: "object" as const,
      properties: {
        intent: { type: "string", enum: [...INTENTS] },
        symbol: { type: ["string", "null"], description: "A ticker from the list, or null" },
        amount: { type: ["string", "null"], description: "Dollar amount the user said, as digits, or null" },
        reply: { type: ["string", "null"], description: "One sentence for explain/unknown, else null" },
      },
      required: ["intent", "symbol", "amount", "reply"],
    },
  };
  return {
    model,
    async classify(transcript, context) {
      // Over the daily limit, or paused after a budget error: the caller uses the rules parser instead.
      if (opts.budget && !opts.budget.tryAcquire()) throw new Error("LLM budget: using rules");
      let response;
      try {
        response = await client.messages.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          tools: [tool],
          tool_choice: { type: "tool", name: tool.name },
          messages: [{ role: "user", content: `Context: ${JSON.stringify(context)}\n\nThe user said: "${transcript}"` }],
        });
      } catch (err) {
        opts.budget?.failed(err);
        throw err;
      }
      logUsage(log, "intent", model, response.usage);
      const use = response.content.find((b) => b.type === "tool_use");
      const parsed = ClaudeIntent.safeParse(use && "input" in use ? use.input : null);
      if (!parsed.success) throw new Error("intent model returned no usable answer");
      const { intent, symbol, amount, reply } = parsed.data;
      return { intent, symbol, amount, modelReply: reply ?? undefined, source: "claude" };
    },
  };
}

/** Claude when available, the rules otherwise (or when Claude fails or is slow); always validated. */
export async function understand(
  transcript: string,
  context: VoiceContext,
  catalog: readonly CatalogEntry[],
  model: IntentModel | null,
): Promise<Intent> {
  let raw: Intent | null = null;
  if (model) {
    try {
      raw = await model.classify(transcript, context);
    } catch {
      raw = null; // fall back to the rules: never an error for the user
    }
  }
  return validateIntent(raw ?? rulesIntent(transcript, catalog), transcript, catalog);
}
