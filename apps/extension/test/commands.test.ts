import { describe, expect, it } from "vitest";

import { parseAmount, parseCommand, type CompanyAliases } from "../lib/commands";

const companies: CompanyAliases[] = [
  { symbol: "TSLA", aliases: ["Tesla", "Tesla Inc", "Tesla Motors", "$TSLA", "TSLA"] },
  { symbol: "AMZN", aliases: ["Amazon", "Amazon.com", "Amazon Web Services", "$AMZN", "AMZN", "AWS"] },
  { symbol: "PLTR", aliases: ["Palantir", "Palantir Technologies", "PLTR"] },
  { symbol: "NFLX", aliases: ["Netflix", "NFLX"] },
  { symbol: "AMD", aliases: ["Advanced Micro Devices", "AMD"] },
];
const parse = (s: string) => parseCommand(s, companies);

describe("amounts", () => {
  it.each([
    ["ten", "10"], ["twenty five", "25"], ["twenty-five", "25"], ["a hundred", "100"], ["one hundred and fifty", "150"],
    ["two thousand", "2000"], ["$25", "25"], ["25", "25"], ["12.50", "12.50"], ["1,000", "1000"],
  ])("%s -> %s", (input, out) => expect(parseAmount(input)).toBe(out));

  it.each(["", "zero", "0", "lots", "ten gazillion", "-5"])("rejects %s", (input) => expect(parseAmount(input)).toBeNull());
});

describe("buy", () => {
  it.each([
    ["buy ten dollars of Tesla", "TSLA", "10"],
    ["Buy $25 of TSLA", "TSLA", "25"],
    ["buy twenty five bucks worth of amazon", "AMZN", "25"],
    ["buy 100 dollars of palantir", "PLTR", "100"],
    ["please buy $10 of netflix", "NFLX", "10"],
    ["buy tesla for ten dollars", "TSLA", "10"],
    ["buy AMD for $50", "AMD", "50"],
    ["buy ten dollars of t s l a", "TSLA", "10"],
    ["buy $12.50 of Tesla stock", "TSLA", "12.50"],
  ])("%s", (said, symbol, amount) => expect(parse(said)).toEqual({ kind: "buy", symbol, amount }));

  it("does not guess an unknown company or amount", () => {
    expect(parse("buy ten dollars of apple").kind).toBe("unknown");
    expect(parse("buy some tesla").kind).toBe("unknown");
    expect(parse("buy tesla").kind).toBe("unknown");
  });
});

describe("price", () => {
  it.each([
    ["what's Tesla at", "TSLA"], ["What is AMD trading at?", "AMD"], ["how's netflix doing", "NFLX"],
    ["price of palantir", "PLTR"], ["how much is amazon", "AMZN"], ["tesla price", "TSLA"], ["TSLA stock price", "TSLA"],
  ])("%s", (said, symbol) => expect(parse(said)).toEqual({ kind: "price", symbol }));
});

describe("spent", () => {
  it.each(["how much have I spent today", "How much did I spend today?", "what have i spent", "how much do I have left today", "how much can I still spend"])(
    "%s",
    (said) => expect(parse(said)).toEqual({ kind: "spent" }),
  );
});

describe("confirm, cancel, unknown", () => {
  it("understands yes and no", () => {
    expect(parse("yes").kind).toBe("confirm");
    expect(parse("go ahead").kind).toBe("confirm");
    expect(parse("cancel").kind).toBe("cancel");
  });

  it("is honest about everything else", () => {
    expect(parse("sing me a song")).toEqual({ kind: "unknown", heard: "sing me a song" });
    expect(parse("what's the weather at home").kind).toBe("unknown");
    expect(parse("").kind).toBe("unknown");
  });
});
