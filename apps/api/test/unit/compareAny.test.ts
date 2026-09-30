/**
 * Compare any two or three US stocks (@glance/core/compare-any, src/compareAny.ts, GET /compare and the spoken
 * compare intent): names become tickers, every number comes from a year of daily closes, the sentence is built in
 * code with no advice, and trading stays with the vault's own stocks.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compareAnySentence, compareNames, compareRow } from "@glance/core/compare-any";
import { containsAdvice, containsChartAdvice } from "@glance/core/tone";
import { compareAnyView, resolveTicker } from "../../src/compareAny.js";
import type { QuoteHistory } from "../../src/chart.js";
import { loadConfig } from "../../src/config.js";
import { createContext, type AppContext } from "../../src/context.js";
import { rulesIntent, validateIntent } from "../../src/voice/intent.js";
import { replyFor } from "../../src/voice/routes.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const DAY = 86_400;
const LAST = Date.UTC(2026, 8, 29, 20) / 1000; // Tuesday, September 29, after the close

/** A year of daily closes: from `start` to `end` in a straight line, then the last two days as given. */
function year(start: number, end: number, lastTwo: [number, number]): Array<{ t: number; price: number }> {
  const n = 365;
  const pts = Array.from({ length: n }, (_, i) => ({ t: LAST - (n - 1 - i) * DAY, price: Math.round((start + ((end - start) * i) / (n - 1)) * 100) / 100 }));
  pts[n - 2]!.price = lastTwo[0];
  pts[n - 1]!.price = lastTwo[1];
  return pts;
}

const SERIES: Record<string, { name: string; points: Array<{ t: number; price: number }> }> = {
  AMD: { name: "Advanced Micro Devices, Inc.", points: year(100, 160, [158, 160]) },
  NVDA: { name: "NVIDIA Corporation", points: year(200, 180, [182, 180]) },
};

function ctxWith(): AppContext {
  const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {});
  ctx.chartOverrides = {
    quoteHistory: (async (ticker: string) => {
      const s = SERIES[ticker];
      if (!s) throw new Error("no such ticker");
      return { points: s.points, detail: `Yahoo Finance ${ticker}, daily closes`, name: s.name } satisfies QuoteHistory;
    }) as never,
    reader: () => {
      throw new Error("offline");
    },
    thresholds: async () => null,
    now: () => LAST,
  };
  return ctx;
}
const search = async (name: string) => (/nvidia/i.test(name) ? "NVDA" : null);

describe("which questions compare stocks by name", () => {
  it.each([
    ["Compare AMD and NVIDIA", ["AMD", "NVIDIA"]],
    ["compare Tesla, Nvidia and Apple this week", ["Tesla", "Nvidia", "Apple"]],
    ["NVIDIA vs AMD today", ["NVIDIA", "AMD"]],
    ["compare Apple's stock with Microsoft's", ["Apple", "Microsoft"]],
    ["compare Tesla", null],
    ["what's Tesla at?", null],
  ])("%s", (q, names) => {
    expect(compareNames(q)).toEqual(names);
  });
});

describe("the numbers", () => {
  it("price, day change, change over the same window, and the 52-week position, from the daily closes", () => {
    const amd = compareRow("AMD", "AMD", SERIES.AMD!.points, "1W")!;
    expect(amd.price).toBe(160);
    expect(amd.dayChangePct).toBe(1.27); // 158 to 160
    const weekAgo = SERIES.AMD!.points.find((p) => p.t === LAST - 7 * DAY)!.price;
    expect(amd.windowChangePct).toBe(Math.round(((160 - weekAgo) / weekAgo) * 10_000) / 100);
    expect(amd.yearPosition).toBe(100); // at its 52-week high
    const nvda = compareRow("NVDA", "NVIDIA", SERIES.NVDA!.points, "1W")!;
    expect(nvda.yearPosition).toBe(0); // at its 52-week low
    expect(compareRow("X", "X", [{ t: LAST, price: 1 }], "1W")).toBeNull();
  });

  it("the sentence says only those numbers, with no advice, no forecast and no dashes", () => {
    const rows = [compareRow("AMD", "AMD", SERIES.AMD!.points, "1W")!, compareRow("NVDA", "NVIDIA", SERIES.NVDA!.points, "1W")!];
    const s = compareAnySentence(rows, "1W");
    expect(s).toMatch(/^This week, AMD rose \d+\.\d{2}% and NVIDIA fell \d+\.\d{2}%\. AMD is at \$160\.00, up 1\.27% on the day and NVIDIA is at \$180\.00, down 1\.10% on the day\. In the last 52 weeks, AMD is 100% of the way from its low to its high and NVIDIA is 0% of the way from its low to its high\.$/);
    expect(containsAdvice(s)).toBe(false);
    expect(containsChartAdvice(s)).toBe(false);
    expect(s).not.toMatch(/[‒-―]/);
  });
});

describe("GET /compare and the spoken compare", () => {
  it("resolves names to tickers: the catalog's own first, a ticker as written, then the search", async () => {
    const ctx = ctxWith();
    expect(await resolveTicker(ctx, "AMD", search)).toBe("AMD");
    expect(await resolveTicker(ctx, "NVIDIA", search)).toBe("NVDA");
    expect(await resolveTicker(ctx, "MSFT", search)).toBe("MSFT");
    expect(await resolveTicker(ctx, "Nothing Real Inc", search)).toBeNull();
  });

  it("compares AMD and NVIDIA from the market's daily closes", async () => {
    const view = await compareAnyView(ctxWith(), ["AMD", "NVIDIA"], "1W", search);
    expect(view.symbols).toEqual(["AMD", "NVDA"]);
    expect(view.rows.map((r) => r.name)).toEqual(["AMD", "NVIDIA"]); // the catalog's own name, else the listing's
    expect(view.sentence).toContain("NVIDIA is at $180.00");
    expect(view.source).toBe("Yahoo Finance daily closes");
  });

  it("a name that matches no US stock is said plainly", async () => {
    await expect(compareAnyView(ctxWith(), ["AMD", "Nothing Real Inc"], "1W", search)).rejects.toMatchObject({ code: "NO_MARKET_DATA", message: "I can't find a US stock called Nothing Real Inc." });
  });

  it("spoken: \"Compare AMD and NVIDIA\" is a compare by name; \"Compare Tesla and AMD\" is unchanged", () => {
    const catalog = ctxWith().catalog.entries;
    const any = validateIntent(rulesIntent("Compare AMD and NVIDIA", catalog, {}), "Compare AMD and NVIDIA", catalog);
    expect(any).toMatchObject({ intent: "compare", names: ["AMD", "NVIDIA"], range: "1W" });
    expect(any.symbols).toBeUndefined();
    const own = validateIntent(rulesIntent("Compare Tesla and AMD", catalog, {}), "Compare Tesla and AMD", catalog);
    expect(own).toMatchObject({ intent: "compare", symbols: ["TSLA", "AMD"] });
    expect(own.names).toBeUndefined();
  });

  it("trading stays with the vault's stocks: \"buy $10 of NVIDIA\" is still refused, never traded", () => {
    const catalog = ctxWith().catalog.entries;
    const it = validateIntent(rulesIntent("buy $10 of NVIDIA", catalog, { pageStock: { symbol: "NVDA", name: "NVIDIA" } }), "buy $10 of NVIDIA", catalog);
    expect(it.intent).toBe("buy");
    expect(it.symbol).toBeNull();
    expect(it.offCatalog).toMatchObject({ symbol: "NVDA" });
  });

  it("the spoken reply is the computed sentence, and the card gets the tickers", async () => {
    const ctx = ctxWith();
    const it = { intent: "compare" as const, symbol: null, amount: null, names: ["AMD", "NVDA"], range: "1W" as const, source: "rules" as const };
    const out = await replyFor(ctx, it, {}, undefined);
    expect(out.reply).toMatch(/^This week, AMD rose/);
    expect(it).toMatchObject({ symbols: ["AMD", "NVDA"] });
  });
});
