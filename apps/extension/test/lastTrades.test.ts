/** Typed questions about past trades (lib/commands.ts): answered from the vault's activity; trade commands stay trades. */
import { describe, expect, it } from "vitest";

import { parseCommand } from "../lib/commands";

const COMPANIES = [
  { symbol: "TSLA", aliases: ["tesla"] },
  { symbol: "AMZN", aliases: ["amazon"] },
];

describe("typed: past trades", () => {
  it.each([
    ["What did I buy last?", { side: "buy", count: 1 }],
    ["What did I sell last?", { side: "sell", count: 1 }],
    ["Show my last 3 trades", { side: "any", count: 3 }],
  ])("%s reads the vault's activity", (q, ask) => {
    expect(parseCommand(q, COMPANIES)).toEqual({ kind: "lastTrades", ask });
  });

  it.each(["buy the last one", "sell what I bought last", "buy $10 of Tesla", "sell all my Tesla"])("%s is never a question about trades", (q) => {
    expect(parseCommand(q, COMPANIES).kind).not.toBe("lastTrades");
  });

  it("the trade commands keep their own paths", () => {
    expect(parseCommand("buy $10 of Tesla", COMPANIES)).toMatchObject({ kind: "buy", symbol: "TSLA" });
    expect(parseCommand("sell all my Tesla", COMPANIES)).toMatchObject({ kind: "sell", symbol: "TSLA" });
    expect(parseCommand("sell what I bought last", COMPANIES).kind).toBe(parseCommand("sell what I bought yesterday", COMPANIES).kind);
  });
});

describe("typed: compare any US stocks", () => {
  it("\"Compare AMD and NVIDIA\" compares by name (NVIDIA is outside the catalog)", () => {
    expect(parseCommand("Compare AMD and NVIDIA", COMPANIES)).toEqual({ kind: "compareAny", names: ["AMD", "NVIDIA"], range: "1W" });
  });
  it("\"compare Tesla and Amazon\" stays the catalog's own comparison", () => {
    expect(parseCommand("compare Tesla and Amazon", COMPANIES)).toMatchObject({ kind: "compare", symbols: ["TSLA", "AMZN"] });
  });
});
