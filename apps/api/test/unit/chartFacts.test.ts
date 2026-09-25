/**
 * Chart breakdowns: every fact computed from fixed fixtures (first, last, change, high and low, the biggest single drop
 * and rise, max drawdown, how bumpy, market-closed stretches, since your last buy); the facts endpoint (one stock, or up
 * to three compared, rebased to 100); grounded answers (an invented number takes its sentence out, a cause needs a
 * source, the fallback is built from the facts, drawings land on the facts' times and prices, the advice guard holds);
 * and the parsers' compare and chart-question phrases. Fake feeds and a fake Claude: no network.
 */
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { LINES } from "@glance/core/persona";
import {
  compareRows,
  compareSentence,
  computeFacts,
  factNumbers,
  factSentences,
  factTimes,
  groundedSentence,
  rebase,
  snapChartTags,
  timeOrderOk,
  type ChartFacts,
} from "@glance/core/chart-facts";
import { isChartQuestion, parseTagged } from "@glance/core/showme";

import { createApp } from "../../src/app.js";
import { roundIdOf, type FeedReader, type Round } from "../../src/chart.js";
import { lastBuyFrom } from "../../src/chartFacts.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import type { MessagesClient } from "../../src/llm.js";
import { HAIKU, LlmBudget } from "../../src/llmBudget.js";
import { createShowMe, endsSentence, groundRaw, showMeUserText, wholeSentences, type ShowMeEvent, type ShowMeInput } from "../../src/showme.js";
import type { ChartSummary } from "../../src/showmeChart.js";
import { rulesIntent, validateIntent } from "../../src/voice/intent.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const env = { NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" };
const ctx = createContext(loadConfig(env), () => {});
const SYMBOLS = new Set(ctx.catalog.entries.map((e) => e.symbol));

// A week of Tesla: 100 -> 102 -> 99, a 10-hour gap (closed), 101 -> 97 -> 104 (times from B, a real unix time).
const B = 1_789_900_000;
const P = [
  { t: B + 1_000, price: 100 },
  { t: B + 2_000, price: 102 },
  { t: B + 3_000, price: 99 },
  { t: B + 39_000, price: 101 },
  { t: B + 40_000, price: 97 },
  { t: B + 41_000, price: 104 },
];
const facts = computeFacts({ symbol: "TSLA", name: "Tesla", range: "1W", source: "Chainlink", asOf: B + 41_100, points: P, lastBuy: { t: B + 2_500, price: 98, amount: 10 } })!;

describe("facts: every calculation", () => {
  it("first, last, change, high and low (with times)", () => {
    expect(facts.first).toEqual({ t: B + 1_000, price: 100 });
    expect(facts.last).toEqual({ t: B + 41_000, price: 104 });
    expect(facts.change).toEqual({ abs: 4, pct: 4 });
    expect(facts.high).toEqual({ t: B + 41_000, price: 104 });
    expect(facts.low).toEqual({ t: B + 40_000, price: 97 });
  });

  it("the biggest single drop and rise between consecutive prices", () => {
    expect(facts.biggestDrop).toEqual({ from: { t: B + 39_000, price: 101 }, to: { t: B + 40_000, price: 97 }, abs: -4, pct: -3.96 });
    expect(facts.biggestRise).toEqual({ from: { t: B + 40_000, price: 97 }, to: { t: B + 41_000, price: 104 }, abs: 7, pct: 7.22 });
  });

  it("max drawdown: the highest price before the deepest trough (102 -> 97), not the overall high", () => {
    expect(facts.maxDrawdown).toEqual({ from: { t: B + 2_000, price: 102 }, to: { t: B + 40_000, price: 97 }, abs: -5, pct: -4.9 });
  });

  it("from the high: where the latest price stands against the peak (\"how much is it down from the peak?\")", () => {
    expect(facts.fromHigh).toEqual({ abs: 0, pct: 0 }); // it ended on its high
    const pltr = computeFacts({ symbol: "PLTR", name: "Palantir", range: "1M", source: "", asOf: 3, points: [{ t: 1, price: 172.27 }, { t: 2, price: 194.56 }, { t: 3, price: 192.55 }] })!;
    expect(pltr.fromHigh).toEqual({ abs: -2.01, pct: -1.03 });
    expect(groundedSentence("It's down $2.01 from the peak, 1.03% below it.", factNumbers(pltr)).ok).toBe(true);
  });

  it("how bumpy: the standard deviation of the point-to-point % changes, with a plain label", () => {
    // Changes: +2, -2.94, +2.02, -3.96, +7.22 -> population standard deviation 4.02.
    expect(facts.bumpiness).toEqual({ stdevPct: 4.02, label: "very bumpy", moves: 5 });
    const calm = computeFacts({ symbol: "X", name: "X", range: "1D", source: "", asOf: 4, points: [1, 2, 3, 4].map((t) => ({ t, price: 100 + t * 0.01 })) })!;
    expect(calm.bumpiness.label).toBe("smooth");
  });

  it("market closed: a stretch of 6 hours or more with no new price, and one still running to now", () => {
    expect(facts.closed).toEqual([{ from: B + 3_000, to: B + 39_000, hours: 10, ongoing: false }]);
    const tail = computeFacts({ symbol: "X", name: "X", range: "1W", source: "", asOf: B + 41_000 + 30 * 3600, points: P })!;
    expect(tail.closed.at(-1)).toEqual({ from: B + 41_000, to: B + 41_000 + 30 * 3600, hours: 30, ongoing: true });
  });

  it("since the last buy: from the price per share paid to the last price", () => {
    expect(facts.sinceBuy).toEqual({ t: B + 2_500, price: 98, amount: 10, abs: 6, pct: 6.12 });
    const cached = {
      usdgDecimals: 6,
      events: [
        { kind: "buy", token: "0xAA", timestamp: 10, usdgIn: 5_000_000n, tokensOut: 10n ** 17n }, // $50 a share
        { kind: "buy", token: "0xaa", timestamp: 20, usdgIn: 10_000_000n, tokensOut: 10n ** 17n }, // $100 a share (the last)
        { kind: "sell", token: "0xAA", timestamp: 30 },
        { kind: "buy", token: "0xBB", timestamp: 40, usdgIn: 1n, tokensOut: 1n },
      ],
    };
    expect(lastBuyFrom(cached, "0xAA", 18)).toEqual({ t: 20, price: 100, amount: 10 });
    expect(lastBuyFrom(null, "0xAA", 18)).toBeNull();
  });

  it("edge cases: fewer than two prices gives nothing; a rising line has no drop and no drawdown", () => {
    expect(computeFacts({ symbol: "X", name: "X", range: "1D", source: "", asOf: 1, points: [{ t: 1, price: 5 }] })).toBeNull();
    const up = computeFacts({ symbol: "X", name: "X", range: "1D", source: "", asOf: 3, points: [{ t: 1, price: 1 }, { t: 2, price: 2 }, { t: 3, price: 3 }] })!;
    expect([up.biggestDrop, up.maxDrawdown]).toEqual([null, null]);
    // A dollar change is the difference of the prices as said: $370.644 -> $367.896 reads $370.64 -> $367.90, down $2.74.
    const r = computeFacts({ symbol: "X", name: "X", range: "1D", source: "", asOf: 2, points: [{ t: 1, price: 370.644 }, { t: 2, price: 367.896 }] })!;
    expect([r.first.price, r.last.price, r.change.abs, r.biggestDrop!.abs]).toEqual([370.64, 367.9, -2.74, -2.74]);
    // Unsorted input and a duplicated time (the later price wins).
    const messy = computeFacts({ symbol: "X", name: "X", range: "1D", source: "", asOf: 3, points: [{ t: 3, price: 9 }, { t: 1, price: 10 }, { t: 1, price: 8 }] })!;
    expect([messy.first.price, messy.change.pct]).toEqual([8, 12.5]);
  });
});

describe("comparisons", () => {
  it("rebases each line to 100 at the range's start", () => {
    expect(rebase([{ t: 2, price: 55 }, { t: 1, price: 50 }, { t: 3, price: 45 }])).toEqual([
      { t: 1, value: 100 },
      { t: 2, value: 110 },
      { t: 3, value: 90 },
    ]);
  });

  it("the rows and the sentence use only the facts (change %, deepest fall, how bumpy)", () => {
    const amd = computeFacts({ symbol: "AMD", name: "AMD", range: "1W", source: "", asOf: 3, points: [{ t: 1, price: 200 }, { t: 2, price: 201 }, { t: 3, price: 199 }] })!;
    expect(compareRows([facts, amd])).toEqual([
      { symbol: "TSLA", name: "Tesla", changePct: 4, maxDrawdownPct: -4.9, bumpiness: { stdevPct: 4.02, label: "very bumpy" } },
      { symbol: "AMD", name: "AMD", changePct: -0.5, maxDrawdownPct: -1, bumpiness: { stdevPct: 0.75, label: "very bumpy" } },
    ]);
    const s = compareSentence([facts, amd]);
    expect(s).toBe("This week, Tesla up 4.00% and AMD down 0.50%. Deepest fall from a peak: Tesla 4.90% and AMD 1.00%. Tesla was the bumpiest (4.02% typical move), AMD the calmest (0.75%).");
    expect(groundedSentence(s, factNumbers([facts, amd])).ok).toBe(true);
  });
});

// A fake Chainlink feed: 300, 301, ... every 6 hours, for GET /chart/:symbols/facts.
const T = 1_790_000_000;
function fakeReader(): FeedReader {
  const rounds = new Map<bigint, Round>();
  const ids = [1n, 2n, 3n, 4n, 5n].map((a) => roundIdOf(1, a));
  ids.forEach((id, i) => rounds.set(id, { roundId: id, answer: BigInt([300, 306, 297, 303, 310][i]!) * 10n ** 8n, updatedAt: T - 3600 - (4 - i) * 6 * 3600 }));
  return {
    decimals: async () => 8,
    latest: async () => rounds.get(ids[4]!)!,
    rounds: async (want) => want.map((id) => rounds.get(id) ?? null),
    phaseLatest: async () => null,
  };
}

describe("GET /chart/:symbols/facts", () => {
  const app = () => {
    const c = createContext(loadConfig(env), () => {});
    c.chartOverrides = { reader: () => fakeReader(), thresholds: async () => null, now: () => T };
    return createApp(c);
  };

  it("one stock: its computed breakdown, no comparison", async () => {
    const res = await app().request("/chart/TSLA/facts?range=1W");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { facts: ChartFacts[]; comparison: unknown };
    expect(body.comparison).toBeNull();
    expect(body.facts[0]).toMatchObject({ symbol: "TSLA", first: { price: 300 }, last: { price: 310 }, change: { abs: 10, pct: 3.33 }, low: { price: 297 } });
    expect(body.facts[0]!.maxDrawdown).toMatchObject({ from: { price: 306 }, to: { price: 297 }, pct: -2.94 });
  });

  it("a list: each line rebased to 100, rows side by side, the sentence; more than three is refused", async () => {
    const res = await app().request("/chart/TSLA,AMD/facts?range=1W");
    const body = (await res.json()) as { comparison: { label: string; lines: Array<{ symbol: string; points: Array<{ value: number }> }>; rows: unknown[]; sentence: string } };
    expect(body.comparison.label).toBe("rebased to 100");
    expect(body.comparison.lines.map((l) => [l.symbol, l.points[0]!.value])).toEqual([
      ["TSLA", 100],
      ["AMD", 100],
    ]);
    expect(body.comparison.rows).toHaveLength(2);
    expect(body.comparison.sentence).toMatch(/^This week, Tesla up 3\.33% and AMD up 3\.33%\./);
    expect((await app().request("/chart/TSLA,AMD,PLTR,NFLX/facts")).status).toBe(400);
    expect((await app().request("/chart/TSLA,NOPE/facts")).status).toBe(404);
  });
});

describe("grounding: every number must be a fact", () => {
  const allowed = factNumbers(facts);

  it.each([
    ["Tesla fell 3.96% in one step, to $97.00.", true],
    ["It ended at $104, up 4%.", true], // rounded as given
    ["At its deepest it was 4.9% below the peak.", true],
    ["It's up 6.12% since you bought it.", true],
    ["Over two days it slipped.", true], // a small count
    ["The S&P 500 ETF did better.", true], // part of a name (allowed separately)
    ["Tesla fell 8% this week.", false], // invented
    ["At its deepest it fell 5%.", true], // 4.90% rounded to a whole number
    ["It averaged $101.50.", false], // computed by the model, not a fact
    ["It dropped 3.9612% at worst.", false], // more precise than given, and not a rounding of it
    ["It fell about three hundred dollars.", false], // spelled out: can't be checked
    ["It fell twelve percent.", false],
  ])("%s -> %s", (text, ok) => {
    expect(groundedSentence(text, allowed, [500]).ok).toBe(ok);
  });

  it("\"then\" must follow time: a real reply had the week's low after its high, when it came before", () => {
    // Low $97.00 at B+40000, high $104.00 at B+41000.
    expect(timeOrderOk("It dipped to $97.00, then climbed to $104.00.", [facts])).toBe(true);
    expect(timeOrderOk("It peaked at $104.00, then dipped to $97.00.", [facts])).toBe(false);
    expect(timeOrderOk("It peaked at $104.00 and its low was $97.00.", [facts])).toBe(true); // no order claimed
    expect(groundRaw("It peaked at $104.00, then dipped to $97.00.", { facts: [facts] }, SYMBOLS)).toBe("drop");
  });

  it("a cause is only allowed with a cached source", () => {
    const summary = (news: ChartSummary["news"]) => [{ symbol: "TSLA", news } as unknown as ChartSummary];
    const said = "Tesla fell 3.96% after Reuters reported weak deliveries.";
    expect(groundRaw(said, { facts: [facts], charts: summary([]) }, SYMBOLS)).toBe("no-news");
    expect(groundRaw(said, { facts: [facts], charts: summary([{ title: "Tesla deliveries miss", site: "Reuters", publishedAt: "2026-09-24T12:00:00Z" }]) }, SYMBOLS)).toBe("keep");
    expect(groundRaw(`It fell 9% [CHART_POINT:TSLA:${B + 40_000}].`, { facts: [facts] }, SYMBOLS)).toBe("drop");
    // Tag times are never checked as spoken numbers.
    expect(groundRaw(`It hit $97.00 [CHART_POINT:TSLA:${B + 40_000}].`, { facts: [facts] }, SYMBOLS)).toBe("keep");
  });
});

describe("drawings on the facts' times and prices", () => {
  it("points and bands snap to fact times; a level snaps to a fact price within 0.5%, or is dropped", () => {
    const tagged = parseTagged(
      `[CHART_POINT:TSLA:${B + 39_900}][CHART_RANGE:TSLA:${B + 2_100}:${B + 40_100}][CHART_LEVEL:TSLA:97.3:"Week low $97.00"][CHART_LEVEL:TSLA:90:"Somewhere"][CHART_LEVEL:TSLA:104:"High $105"]`,
      { symbols: SYMBOLS },
    );
    const snapped = snapChartTags(tagged, [facts]).actions;
    expect(snapped).toEqual([
      { kind: "CHART_POINT", symbol: "TSLA", t: B + 40_000, at: 0 },
      { kind: "CHART_RANGE", symbol: "TSLA", t1: B + 2_000, t2: B + 40_000, at: 0 },
      { kind: "CHART_LEVEL", symbol: "TSLA", price: 97, label: "Week low $97.00", at: 0 },
      // 90 is no fact price; "High $105" names a number that isn't one of the facts.
    ]);
    expect(factTimes(facts)).toEqual(expect.arrayContaining([B + 2_000, B + 40_000, B + 41_000]));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Whole answers, through a fake Claude
// ---------------------------------------------------------------------------------------------------------------------

const T0 = Date.parse("2026-09-24T12:00:00Z");
const budget = () => new LlmBudget({ total: 250, perPurpose: { resolver: 40, intent: 80, why: 60, other: 70 } }, null, () => {}, () => T0);
function fake(text: string) {
  const create = vi.fn(async (params: { stream?: boolean }) => {
    if (!params.stream) return { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "end_turn" };
    return (async function* () {
      yield { type: "message_start", message: { usage: { input_tokens: 10 } } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text } };
      yield { type: "message_delta", usage: { output_tokens: 10 } };
    })();
  });
  return { client: { messages: { create } } as unknown as MessagesClient, create };
}
const summary: ChartSummary = {
  symbol: "TSLA",
  name: "Tesla",
  range: "1W",
  source: "Chainlink",
  points: P,
  high: P[5]!,
  low: P[4]!,
  first: P[0]!,
  latest: P[5]!,
  markers: [],
  news: [],
};
const input: ShowMeInput = { question: "how did Tesla do this week?", page: { title: "t", text: "" }, charts: [summary], facts: [facts] };
const make = (text: string, log: string[] = []) => createShowMe({ model: HAIKU, budget: budget(), symbols: [...SYMBOLS], client: fake(text).client, log: (l) => log.push(l), nameNumbers: [500, 100] })!;

describe("grounded answers", () => {
  it("the prompt carries the facts as the only numbers, and leaves the raw points out", () => {
    const text = showMeUserText(input);
    expect(text).toContain('<chart_facts symbol="TSLA"');
    expect(text).toContain("max drawdown (peak to trough): down 4.90% ($5.00), from $102.00");
    expect(text).toContain("how bumpy: 4.02% typical move between prices (very bumpy)");
    expect(text).toContain("points (unix time, price): see <chart_facts>");
    expect(text).not.toContain(`${B + 39_000} 101.00`);
  });

  it("an invented number takes its sentence out; the rest is said; the counter is logged, not the text", async () => {
    const log: string[] = [];
    const a = await make(`Tesla ended the week up 4% [CHART:TSLA]. Its average was $101.37. The low was $97.00 [CHART_POINT:TSLA:${B + 40_010}].`, log).answer(input);
    expect(a.spoken).toBe("Tesla ended the week up 4%. The low was $97.00.");
    expect(a.actions.find((x) => x.kind === "CHART_POINT")).toMatchObject({ t: B + 40_000 }); // the low's own time
    expect(log.some((l) => /grounding removed 1 sentence/.test(l))).toBe(true);
    expect(log.join("\n")).not.toContain("101.37");
  });

  it("nothing survives: the facts' own sentences instead, with the chart", async () => {
    const a = await make("Tesla fell 8% this week. It lost about twenty dollars.").answer(input);
    expect(a.spoken).toBe(factSentences(facts).join(" "));
    expect(a.spoken).toBe("Tesla went from $100.00 to $104.00 this week, up $4.00 (4.00%). The high was $104.00 and the low $97.00. At its deepest it was down 4.90% from its peak. Since your last buy at $98.00, it's up 6.12%.");
    expect(a.chart).toEqual({ symbol: "TSLA", range: "1W" });
    // The high and the low it names are marked at the facts' own times.
    expect(a.actions.filter((x) => x.kind === "CHART_POINT").map((x) => (x as { t: number }).t)).toEqual([facts.high.t, facts.low.t]);
  });

  it("grounding leaves no figure (a real reply: the number spelled out): the facts answer the question asked", async () => {
    const raw = "Tesla's biggest single drop this week was down three point nine six percent, on Tuesday. I don't have news that explains this move.";
    const q = { ...input, question: "what was Tesla's biggest drop this week?" };
    const a = await make(raw).answer(q);
    expect(a.spoken).toMatch(/^The biggest single drop was 3\.96%, from \$101\.00 to \$97\.00, \w+ \w+\. /);
    expect(a.spoken.endsWith(LINES.noNewsForMove)).toBe(true);
    const events: ShowMeEvent[] = [];
    await make(raw).answerStream(q, (e) => events.push(e));
    const said = events.flatMap((e) => (e.type === "sentence" ? [e.sentence.spoken] : []));
    expect(said[0]).toBe(LINES.noNewsForMove);
    expect(said[1]).toMatch(/^The biggest single drop was 3\.96%/);
  });

  it("a cause with no cached news: replaced by the plain line", async () => {
    const a = await make("It dropped 3.96% in one step because deliveries missed. It closed at $104.").answer(input);
    expect(a.spoken).toBe(`${LINES.noNewsForMove} It closed at $104.`);
  });

  it("a long sentence the splitter cuts at a comma is kept or dropped whole, never half", async () => {
    // A real reply: the number was spelled out, and the sentence is long enough to be cut at its comma.
    const raw = `Here's Tesla's week [CHART:TSLA]. The biggest single drop was down one point zero three percent over a short stretch of trading on Monday morning, from Monday morning to Monday morning [CHART_RANGE:TSLA:${B + 39_000}:${B + 40_000}]. It ended at $104.`;
    expect(wholeSentences(["a,", "b [CHART:TSLA].", "c"])).toEqual(["a, b [CHART:TSLA].", "c"]);
    expect([endsSentence("up 4% [CHART_POINT:TSLA:1790000000]."), endsSentence("up 4%,"), endsSentence('It ended [CIRCLE:"x."],')]).toEqual([true, false, false]);
    const a = await make(raw).answer(input);
    expect(a.spoken).toBe("Here's Tesla's week. It ended at $104.");
    const events: ShowMeEvent[] = [];
    await make(raw).answerStream(input, (e) => events.push(e));
    expect(events.flatMap((e) => (e.type === "sentence" ? [e.sentence.spoken] : []))).toEqual(["Here's Tesla's week.", "It ended at $104."]);
  });

  it("streamed: the same rules, sentence by sentence", async () => {
    const events: ShowMeEvent[] = [];
    await make("Tesla ended up 4%. It averaged $101.37. The biggest single drop was 3.96%.").answerStream(input, (e) => events.push(e));
    const said = events.flatMap((e) => (e.type === "sentence" ? [e.sentence.spoken] : []));
    expect(said).toEqual(["Tesla ended up 4%.", "The biggest single drop was 3.96%."]);
  });

  it("the advice guard stays on chart replies: no support, target or will", async () => {
    for (const text of ["Tesla found support at $97.00.", "The next target is $104.", "It will keep climbing from $104."]) {
      expect((await make(text).answer(input)).spoken).toBe(LINES.noAdvice);
    }
    // A forecast in a drawing's label drops the drawing, not the answer.
    const a = await make('The low was $97.00 [CHART_LEVEL:TSLA:97:"Support $97.00"].').answer(input);
    expect(a.actions.some((x) => x.kind === "CHART_LEVEL")).toBe(false);
  });

  it("no screenshot possible: the answer says how to allow one", async () => {
    const a = await make("I can't see that chart from here.").answer({ question: "what does this chart show?", page: { text: "" }, noScreenshot: { glanceKey: "⌥G" } });
    expect(a.spoken).toBe(`I can't see that chart from here. ${LINES.pressGlanceForChart("⌥G")}`);
    expect(LINES.pressGlanceForChart()).toBe("Press ⌥G on this page first and I can look at that chart.");
  });
});

describe("parsers: compare and chart questions, rules first", () => {
  const catalog = ctx.catalog.entries;
  const intent = (said: string) => validateIntent(rulesIntent(said, catalog), said, catalog);

  it.each([
    ["compare Tesla and AMD this week", ["TSLA", "AMD"], "1W"],
    ["compare Tesla, AMD and Netflix today", ["TSLA", "AMD", "NFLX"], "1D"],
    ["Palantir vs Amazon this month", ["PLTR", "AMZN"], "1M"],
    ["compare tesla and amd", ["TSLA", "AMD"], "1W"],
  ])("%s", (said, symbols, range) => {
    expect(intent(said)).toMatchObject({ intent: "compare", symbols, range, symbol: null, source: "rules" });
  });

  it("a comparison needs 2 or 3 stocks", () => {
    expect(intent("compare Tesla").intent).not.toBe("compare");
    expect(intent("compare Tesla, AMD, Netflix and Palantir").intent).not.toBe("compare");
  });

  it.each(["how did Tesla do this week?", "what was the biggest drop?", "how much is it down from the peak?", "how am I doing on AMD since I bought?", "how bumpy was Palantir this month?"])(
    "%s -> Show me with the facts",
    (said) => {
      expect(isChartQuestion(said)).toBe(true);
      expect(intent(said).intent).toBe("ask");
    },
  );

  it("the whole portfolio is still the portfolio", () => {
    expect(intent("how am I doing?").intent).toBe("portfolio");
  });
});
