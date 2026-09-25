/**
 * Chart questions in the extension: "compare X and Y [today|this week|this month]" and the chart questions that go to
 * Show me (before "how am I doing"); the comparison card draws each line rebased to 100 in the design system's
 * comparison colors and dashes, with a legend and the three numbers side by side, all from the facts endpoint.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { compareSeries } from "@glance/core/chart";
import { describe, expect, it } from "vitest";

import { comparePaths, CompareView } from "../components/CompareCard";
import type { ChartFactsView } from "../lib/api-types";
import { parseCommand, type CompanyAliases } from "../lib/commands";

const companies: CompanyAliases[] = [
  { symbol: "TSLA", aliases: ["Tesla", "TSLA"] },
  { symbol: "AMD", aliases: ["Advanced Micro Devices", "AMD"] },
  { symbol: "NFLX", aliases: ["Netflix", "NFLX"] },
  { symbol: "PLTR", aliases: ["Palantir", "PLTR"] },
];

describe("parser", () => {
  it.each([
    ["compare Tesla and AMD this week", ["TSLA", "AMD"], "1W"],
    ["Compare tesla, amd and netflix today", ["TSLA", "AMD", "NFLX"], "1D"],
    ["tesla vs palantir this month", ["TSLA", "PLTR"], "1M"],
  ])("%s", (said, symbols, range) => {
    expect(parseCommand(said, companies)).toEqual({ kind: "compare", symbols, range });
  });

  it("four stocks, or one, isn't a comparison", () => {
    expect(parseCommand("compare tesla, amd, netflix and palantir", companies).kind).not.toBe("compare");
    expect(parseCommand("compare tesla", companies).kind).not.toBe("compare");
  });

  it.each(["how did Tesla do this week?", "what was the biggest drop?", "how much is it down from the peak?", "how am I doing on AMD since I bought?"])("%s -> Show me", (said) => {
    expect(parseCommand(said, companies)).toEqual({ kind: "ask", question: said });
  });

  it("\"how am I doing?\" alone is still the portfolio", () => {
    expect(parseCommand("how am I doing", companies)).toEqual({ kind: "portfolio" });
  });
});

const view: ChartFactsView = {
  range: "1W",
  facts: [],
  comparison: {
    label: "rebased to 100",
    lines: [
      { symbol: "TSLA", name: "Tesla", points: [{ t: 1, value: 100 }, { t: 2, value: 104 }, { t: 3, value: 102 }] },
      { symbol: "AMD", name: "AMD", points: [{ t: 1, value: 100 }, { t: 2, value: 97 }, { t: 3, value: 99.5 }] },
    ],
    rows: [
      { symbol: "TSLA", name: "Tesla", changePct: 2, maxDrawdownPct: -1.92, bumpiness: { stdevPct: 0.4, label: "bumpy" } },
      { symbol: "AMD", name: "AMD", changePct: -0.5, maxDrawdownPct: -3, bumpiness: { stdevPct: 0.2, label: "a little bumpy" } },
    ],
    sentence: "",
  },
};

describe("comparison card", () => {
  it("lines start together on the 100 baseline, on shared axes", () => {
    const { paths, baseline, lo, hi } = comparePaths(view.comparison!.lines, 100, 100, 0);
    expect([lo, hi]).toEqual([97, 104]);
    // Both lines start at x=0 on the baseline (value 100).
    for (const d of paths) expect(d.startsWith(`M0.0,${baseline.toFixed(1)}`)).toBe(true);
  });

  it("labelled rebased to 100, a legend in the comparison colors and dashes, and the numbers side by side", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(CompareView, { view })));
    expect(host.querySelector("svg[role=img]")!.getAttribute("aria-label")).toBe("Tesla, AMD, rebased to 100");
    expect(host.textContent).toContain("rebased to 100 at the start");
    const series = compareSeries("dark");
    const lines = [...host.querySelectorAll("path[data-symbol]")];
    expect(lines.map((p) => [p.getAttribute("data-symbol"), p.getAttribute("stroke"), p.getAttribute("stroke-dasharray")])).toEqual([
      ["TSLA", series[0]!.color, null],
      ["AMD", series[1]!.color, series[1]!.dash],
    ]);
    expect([...host.querySelectorAll("[role=listitem]")].map((l) => l.textContent)).toEqual(["TeslaTSLA", "AMDAMD"]);
    const row = (s: string) => [...host.querySelectorAll(`tr[data-row=${s}] td`)].map((td) => td.textContent);
    expect(row("TSLA")).toEqual(["+2.00%", "-1.92%", "0.40% · bumpy"]);
    expect(row("AMD")).toEqual(["-0.50%", "-3.00%", "0.20% · a little bumpy"]);
    act(() => root.unmount());
  });
});
