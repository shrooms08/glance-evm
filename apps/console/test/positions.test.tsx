/** The Dashboard's Positions card (GET /portfolio): value, average cost, PnL coloured by direction, price age. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PositionsTable } from "../components/PositionsCard";
import type { PortfolioView } from "../lib/api";

afterEach(cleanup);
const m = (formatted: string, raw = "1") => ({ raw, value: raw, formatted });

const data: PortfolioView = {
  usdg: m("$110"),
  positions: [
    { symbol: "TSLA", name: "Tesla", qty: m("0.0262 TSLA"), avgCost: m("$381.07"), costBasis: m("$10"), price: { raw: "1", decimals: 8, value: "378", formatted: "$378.03" }, priceAge: { seconds: 13_338, text: "4 hours" }, marketState: "OPEN", value: m("$9.92"), unrealizedPnl: m("-$0.08"), unrealizedPnlPct: "-0.8%", realizedPnl: m("$0", "0"), transferredIn: null },
    { symbol: "AMD", name: "AMD", qty: m("0.02 AMD"), avgCost: m("$600"), costBasis: m("$12"), price: { raw: "1", decimals: 8, value: "620", formatted: "$620" }, priceAge: { seconds: 60, text: "1 minute" }, marketState: "OPEN", value: m("$12.40"), unrealizedPnl: m("+$0.40"), unrealizedPnlPct: "+3.3%", realizedPnl: m("$0", "0"), transferredIn: m("0.001 AMD") },
  ],
  totals: { value: m("$132.32"), stocksValue: m("$22.32"), costBasis: m("$22"), unrealizedPnl: m("+$0.32"), unrealizedPnlPct: "+1.5%", realizedPnl: m("$0", "0") },
  sentence: "",
};

describe("PositionsTable", () => {
  it("shows each position with average cost, value, PnL in $ and %, and price age", () => {
    render(<PositionsTable data={data} />);
    expect(screen.getByText("$381.07")).toBeTruthy();
    const down = screen.getByText("-$0.08 · -0.8%");
    const up = screen.getByText("+$0.40 · +3.3%");
    expect(down.className).toContain("pnl-down");
    expect(up.className).toContain("pnl-up");
    expect(screen.getByText("4 hours")).toBeTruthy();
    expect(screen.getByText(/Includes 0.001 AMD sent in, at no cost/)).toBeTruthy();
  });
});
