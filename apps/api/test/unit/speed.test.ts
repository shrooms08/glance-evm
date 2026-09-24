/**
 * Speed without Claude where it isn't needed: the rules decide clear commands on their own (no Claude call), Claude
 * still reads what the rules can't; Show me sends the paragraphs that bear on the question, not the whole page; the
 * short answers have smaller output caps.
 */
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { showMeUserText } from "../../src/showme.js";
import { RELEVANT_MAX_CHARS, relevantText } from "../../src/showmeContext.js";
import { INTENT_MAX_OUTPUT_TOKENS, understand, type IntentModel } from "../../src/voice/intent.js";
import { WHY_MAX_OUTPUT_TOKENS } from "../../src/why.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {});
const catalog = ctx.catalog.entries;

function model(answer: Partial<Awaited<ReturnType<IntentModel["classify"]>>> = {}) {
  const classify = vi.fn(async () => ({ intent: "unknown" as const, symbol: null, amount: null, source: "claude" as const, ...answer }));
  return { model: { model: "fake", classify } as IntentModel, classify };
}

describe("the rules fast path", () => {
  it("clear commands are decided by the rules: no Claude call", async () => {
    const cases: Array<[string, string, string | null]> = [
      ["what's Tesla at?", "price", "TSLA"],
      ["What's Tesla?", "price", "TSLA"], // speech-to-text dropped the "at"
      ["how's AMD?", "price", "AMD"],
      ["how am I doing?", "portfolio", null],
      ["buy ten dollars of Tesla", "buy", "TSLA"],
      ["By $10 of Tesla.", "buy", "TSLA"], // speech-to-text wrote "buy" as "by"
      ["show me Tesla's chart", "chart", "TSLA"],
      ["why did Tesla drop?", "why", "TSLA"],
      ["how much have I spent today?", "spend-so-far", null],
      ["show me the key numbers in this article", "ask", null],
    ];
    for (const [said, intent, symbol] of cases) {
      const m = model();
      const got = await understand(said, {}, catalog, m.model);
      expect([said, got.intent, got.symbol, got.source]).toEqual([said, intent, symbol, "rules"]);
      expect(m.classify).not.toHaveBeenCalled();
    }
  });

  it("advice is still declined, from the rules alone", async () => {
    const m = model();
    const got = await understand("should I buy Tesla?", {}, catalog, m.model);
    expect(got.intent).toBe("price");
    expect(got.note).toContain("advice");
    expect(m.classify).not.toHaveBeenCalled();
  });

  it("what the rules can't read goes to Claude (still validated)", async () => {
    const m = model({ intent: "price", symbol: "NOTREAL" });
    const got = await understand("hmm Tesla, thoughts on where that's sitting", {}, catalog, m.model);
    expect(m.classify).toHaveBeenCalledTimes(1);
    expect(got.intent).toBe("unknown"); // an unknown ticker never gets through
    const e = model({ intent: "explain", modelReply: "It was over your daily limit." });
    expect((await understand("why was that refused?", {}, catalog, e.model)).intent).toBe("explain");
    expect(e.classify).toHaveBeenCalledTimes(1);
  });

  it("the short answers have smaller output caps", () => {
    expect(INTENT_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(150);
    expect(WHY_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(200);
  });
});

describe("a smaller Show me context", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i} is about the history of the company and its early years in California and elsewhere.`);
  const page = ["Tesla, Inc. is a car company.", ...filler(120), "Cybertruck", "The Cybertruck went on sale in 2023 at $60,990.", ...filler(120), "Revenue grew 12% to $25.2 billion in 2024."].join("\n");

  it("keeps the opening and the paragraphs the question is about, in page order, within about 2,500 tokens", () => {
    const r = relevantText(page, "where does it talk about the Cybertruck?");
    expect(r.selected).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(RELEVANT_MAX_CHARS);
    expect(r.text.startsWith("Tesla, Inc. is a car company.")).toBe(true);
    expect(r.text).toContain("Cybertruck\nThe Cybertruck went on sale"); // with its heading
    expect(r.text).toContain("…");
  });

  it("a question about numbers finds the paragraphs with figures in them", () => {
    const r = relevantText(page, "show me the key numbers");
    expect(r.text).toContain("Revenue grew 12% to $25.2 billion");
    expect(r.text).toContain("$60,990");
  });

  it("nothing to match on, or a short page: the whole extract, as before", () => {
    expect(relevantText(page, "what's this about?")).toEqual({ text: page.slice(0, 24_000), selected: false });
    expect(relevantText("Short page.", "show me the numbers")).toEqual({ text: "Short page.", selected: false });
  });

  it("the prompt carries the selected paragraphs", () => {
    const text = showMeUserText({ question: "show me the Cybertruck part", page: { text: page } });
    expect(text).toContain("The Cybertruck went on sale");
    expect(text.length).toBeLessThan(RELEVANT_MAX_CHARS + 1_000);
  });
});
