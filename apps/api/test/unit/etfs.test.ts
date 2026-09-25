/**
 * The ETF stand-ins (SPY, QQQ): the resolver underlines their names and tickers ("S&P 500 ETF", "SPY", "Nasdaq-100",
 * "QQQ") without lighting up ordinary prose; the catalog lists them (so prices, charts, quotes and underlines work) only
 * once the deployment record has them, exactly as `make deploy-etf-standins` writes it; voice understands them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildCatalog, loadCatalogText, loadPriceSources } from "../../src/catalog.js";
import { deploymentSchema, loadDeployment } from "../../src/deployment.js";
import { Resolver } from "../../src/resolver.js";
import { rulesIntent, validateIntent } from "../../src/voice/intent.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const real = loadDeployment(resolve(ROOT, "deployments/46630.json"));
const sources = loadPriceSources(resolve(ROOT, "config/price-sources.json"));
const resolver = new Resolver(loadCatalogText());
const symbols = (text: string) => resolver.resolve(text).map((m) => m.symbol);

/** The record after `make deploy-etf-standins` (the entries DeployEtfStandIns.s.sol writes, as the dry run printed). */
function withEtfs() {
  const raw = JSON.parse(readFileSync(resolve(ROOT, "deployments/46630.json"), "utf8")) as { stocks: Record<string, unknown> };
  const etf = (token: string, feed: string, mainnetToken: string, mainnetFeed: string, price: number) => ({
    skipped: false,
    etfStandIn: true,
    token,
    tokenReal: false,
    tokenSource: "TestStockToken: testnet stand-in",
    tokenDecimals: 18,
    mainnetToken,
    feed,
    feedReal: false,
    feedSource: "TestPriceFeed",
    mainnetFeed,
    priceSource: `chainlink-live: Robinhood mainnet feed ${mainnetFeed}, updated 2026-09-25T04:04Z`,
    priceSourceKind: "chainlink-live",
    priceDecimals: 8,
    price,
  });
  raw.stocks.SPY = etf("0x5d7bEAe66da99B88Aa1ACE7C49F72e5AFBd59c02", "0xd30ecC9836d4Fa8f27e1Fb037Ee8FF2535dc5f31", "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", "0x319724394D3A0e3669269846abE664Cd621f9f6A", 76_843_289_680);
  raw.stocks.QQQ = etf("0x1f2676a6f87c516e48f32DD73bE44E910E66350c", "0x8831c6e248C95168F165eAA7C70173A3f1bd5413", "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", "0x80901d846d5D7B030F26B480776EE3b29374C2ae", 74_178_447_201);
  return deploymentSchema.parse(raw);
}

describe("resolver: ETF names and tickers", () => {
  it.each([
    ["The S&P 500 ETF hit a record", "SPY", "S&P 500 ETF"],
    ["Flows into SPY slowed", "SPY", "SPY"],
    ["$spy calls", "SPY", "$spy"],
    ["the SPDR S&P 500 ETF Trust's assets", "SPY", "SPDR S&P 500 ETF Trust"],
    ["The Nasdaq-100 fell 2%", "QQQ", "Nasdaq-100"],
    ["tech-heavy Nasdaq 100 rallied", "QQQ", "Nasdaq 100"],
    ["QQQ outflows", "QQQ", "QQQ"],
    ["Invesco QQQ Trust", "QQQ", "Invesco QQQ Trust"],
  ])("%s -> %s (%s)", (text, symbol, matched) => {
    const [m] = resolver.resolve(text);
    expect(m).toMatchObject({ symbol, text: matched });
  });

  it("ordinary prose doesn't light up", () => {
    expect(symbols("a spy in the embassy")).toEqual([]); // lowercase ticker: not a ticker
    expect(symbols("NEW SPY THRILLER TOPS CHARTS")).toEqual([]);
    expect(symbols("SPY software and espionage")).toEqual([]);
    expect(symbols("The S&P 500 rose")).toEqual([]); // the index, not the ETF
  });

  it("an ETF and a company in one sentence", () => {
    expect(symbols("Tesla lagged the S&P 500 ETF and QQQ")).toEqual(["TSLA", "SPY", "QQQ"]);
  });
});

describe("catalog: ETFs only once deployed", () => {
  it("before make deploy-etf-standins: no ETFs (nothing to price, chart or underline)", () => {
    const { SPY: _spy, QQQ: _qqq, ...stocks } = real.stocks;
    const c = buildCatalog({ ...real, stocks }, loadCatalogText(), sources);
    expect(c.bySymbol.has("SPY")).toBe(false);
    expect(c.text.map((t) => t.symbol)).not.toContain("QQQ");
  });

  it("today's record (deployed 25 Sep 2026): both stand-ins listed, not real tokens, mirrored from their mainnet feeds", () => {
    const c = buildCatalog(real, loadCatalogText(), sources);
    expect(c.bySymbol.get("SPY")).toMatchObject({ tokenReal: false, feedReal: false, mainnetFeed: "0x319724394D3A0e3669269846abE664Cd621f9f6A" });
    expect(c.bySymbol.get("QQQ")).toMatchObject({ tokenReal: false, feedReal: false, mainnetFeed: "0x80901d846d5D7B030F26B480776EE3b29374C2ae" });
  });

  it("after make deploy-etf-standins: listed, marked stand-ins, mirrored from their mainnet feeds", () => {
    const c = buildCatalog(withEtfs(), loadCatalogText(), sources);
    expect(c.bySymbol.get("SPY")).toMatchObject({
      name: "S&P 500 ETF",
      legalName: "SPDR S&P 500 ETF Trust",
      tokenReal: false,
      feedReal: false,
      priceSourceKind: "mainnet-mirror",
      mainnetFeed: "0x319724394D3A0e3669269846abE664Cd621f9f6A",
    });
    expect(c.bySymbol.get("QQQ")).toMatchObject({ name: "Nasdaq-100 ETF", mainnetFeed: "0x80901d846d5D7B030F26B480776EE3b29374C2ae" });
    expect(c.bySymbol.get("SPY")!.aliases).toEqual(expect.arrayContaining(["S&P 500 ETF", "SPY", "$SPY"]));
    // Underlines come from the deployed catalog text.
    expect(new Resolver(c.text).resolve("SPY and QQQ").map((m) => m.symbol)).toEqual(["SPY", "QQQ"]);
  });

  it("voice: \"buy $20 of the S&P 500 ETF\", \"what's QQQ at?\"", () => {
    const catalog = buildCatalog(withEtfs(), loadCatalogText(), sources).entries;
    const intent = (said: string) => validateIntent(rulesIntent(said, catalog), said, catalog);
    expect(intent("buy $20 of the S&P 500 ETF")).toMatchObject({ intent: "buy", symbol: "SPY", amount: "20" });
    expect(intent("what's QQQ at")).toMatchObject({ intent: "price", symbol: "QQQ" });
    expect(intent("show me the Nasdaq 100 chart")).toMatchObject({ intent: "chart", symbol: "QQQ" });
  });
});
