import { describe, expect, it } from "vitest";

import { loadCatalogText } from "../../src/catalog.js";
import { Resolver } from "../../src/resolver.js";

const resolver = new Resolver(loadCatalogText());
const symbols = (text: string) => resolver.resolve(text).map((m) => m.symbol);

describe("resolver: finds companies", () => {
  it("matches names case-insensitively with exact offsets", () => {
    const text = "Shares of tesla jumped while NETFLIX slid.";
    const [tesla, netflix] = resolver.resolve(text);
    expect(tesla).toMatchObject({ symbol: "TSLA", text: "tesla", start: 10, end: 15, kind: "name" });
    expect(text.slice(tesla!.start, tesla!.end)).toBe("tesla");
    expect(netflix).toMatchObject({ symbol: "NFLX", text: "NETFLIX" });
  });

  it("matches possessives and punctuation", () => {
    expect(symbols("Tesla's margins")).toEqual(["TSLA"]);
    expect(symbols("(Palantir)")).toEqual(["PLTR"]);
    expect(symbols("Amazon.")).toEqual(["AMZN"]);
    expect(symbols('"Netflix",')).toEqual(["NFLX"]);
  });

  it("prefers the longest alias", () => {
    const [m] = resolver.resolve("Palantir Technologies reported earnings");
    expect(m).toMatchObject({ symbol: "PLTR", text: "Palantir Technologies" });
    const [n] = resolver.resolve("Advanced Micro Devices beat estimates");
    expect(n).toMatchObject({ symbol: "AMD", text: "Advanced Micro Devices" });
    expect(resolver.resolve("Tesla, Inc. filed")[0]).toMatchObject({ text: "Tesla, Inc." });
  });

  it("matches capitalised tickers and cashtags in any case", () => {
    expect(symbols("TSLA and AMD")).toEqual(["TSLA", "AMD"]);
    expect(symbols("$tsla to the moon, $Pltr too")).toEqual(["TSLA", "PLTR"]);
    expect(resolver.resolve("buy $NFLX")[0]).toMatchObject({ kind: "cashtag", text: "$NFLX", start: 4, end: 9 });
  });

  it("finds each mention, in order", () => {
    expect(symbols("Tesla, then Amazon, then Tesla again")).toEqual(["TSLA", "AMZN", "TSLA"]);
  });

  it("counts offsets in UTF-16 units, as the DOM does", () => {
    const text = "📈 Tesla up";
    const [m] = resolver.resolve(text);
    expect(text.slice(m!.start, m!.end)).toBe("Tesla");
    expect(m!.start).toBe(3);
  });
});

describe("resolver: near misses that must not match", () => {
  it.each([
    ["Teslas are everywhere on this street", "plural"],
    ["an Amazonian species", "longer word"],
    ["the Amazon rainforest is burning", "rainforest"],
    ["boats on the Amazon River", "river"],
    ["deforestation across the Amazon accelerated", "nearby context"],
    ["Nikola Tesla invented it", "the inventor"],
    ["a 3 tesla MRI scanner", "unit of magnetic field"],
    ["a tesla coil demonstration", "tesla coil"],
    ["AMD, or age-related macular degeneration, affects eyesight", "eye disease"],
    ["the command was amended", "amd inside words"],
    ["we use amd hardware", "lowercase ticker"],
    ["the aws of the lion", "lowercase aws"],
    ["NFLXX is not a ticker", "ticker prefix"],
    ["my email is tsla@example.com? no, it is xTSLA", "embedded ticker"],
    ["a netflixer and palantirs", "suffixed names"],
    ["Saruman looked into the palantir", "Tolkien"],
    ["$TSLAQ", "cashtag prefix"],
  ])("%s (%s)", (text) => {
    expect(symbols(text)).toEqual([]);
  });

  it("still matches the company when an excluded phrase is elsewhere", () => {
    // "Amazon rainforest" is excluded, but a separate mention of Amazon.com far away still counts.
    const filler = " ".repeat(120);
    expect(symbols(`Amazon.com shipped more.${filler}Separately, the Amazon rainforest...`)).toEqual(["AMZN"]);
  });
});
