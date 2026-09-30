/**
 * "What did I buy last?", "What did I sell last?", "Show my last 3 trades": the vault's own activity, read only
 * (@glance/core/trades). The routing never takes a command to trade: "buy the last one" and "sell what I bought last"
 * stay on the trade paths (and their confirm cards).
 */
import { describe, expect, it } from "vitest";

import { lastTradesAsk, lastTradesReply, NO_VAULT_TRADES } from "@glance/core/trades";
import { rulesIntent, validateIntent } from "../../src/voice/intent.js";
import { replyFor } from "../../src/voice/routes.js";

const CATALOG = [{ symbol: "TSLA", name: "Tesla", legalName: "Tesla, Inc.", aliases: [] }] as never;
const T = Date.UTC(2026, 8, 28, 15) / 1000; // Monday, September 28

const ITEMS = [
  { type: "Refused", kind: "refusal", summary: "Refused: over the daily cap", timestamp: T + 400 },
  { type: "Sold", kind: "trade", summary: "Sold 0.0100 TSLA for $3.52", timestamp: T + 300 },
  { type: "Deposited", kind: "owner", summary: "Deposited $100.00", timestamp: T + 200 },
  { type: "Bought", kind: "trade", summary: "Bought 0.0263 TSLA for $10.00", timestamp: T + 100 },
  { type: "Bought", kind: "trade", summary: "Bought 0.0140 AMZN for $5.00", timestamp: T - 86_400 },
];

describe("which questions are about past trades", () => {
  it.each([
    ["What did I buy last?", { side: "buy", count: 1 }],
    ["what did i just buy", null],
    ["What was my last purchase?", { side: "buy", count: 1 }],
    ["What did I sell last?", { side: "sell", count: 1 }],
    ["what was my most recent sale", { side: "sell", count: 1 }],
    ["Show my last 3 trades", { side: "any", count: 3 }],
    ["show me my last three trades", { side: "any", count: 3 }],
    ["what was my last trade?", { side: "any", count: 1 }],
    ["my trade history", { side: "any", count: 3 }],
  ])("%s", (q, want) => {
    expect(lastTradesAsk(q)).toEqual(want);
  });

  it.each(["buy the last one", "sell what I bought last", "buy $10 of what I bought last", "sell my last buy", "please sell what I bought last"])(
    "%s is a trade command, never a question about trades",
    (q) => {
      expect(lastTradesAsk(q)).toBeNull();
    },
  );
});

describe("spoken routing", () => {
  const route = (q: string) => validateIntent(rulesIntent(q, CATALOG, { pageStock: { symbol: "TSLA", name: "Tesla" } }), q, CATALOG);

  it("routes the three questions to last-trades, with no stock and no amount", () => {
    expect(route("What did I buy last?")).toMatchObject({ intent: "last-trades", symbol: null, amount: null, trades: { side: "buy", count: 1 } });
    expect(route("What did I sell last?")).toMatchObject({ intent: "last-trades", trades: { side: "sell", count: 1 } });
    expect(route("Show my last 3 trades")).toMatchObject({ intent: "last-trades", trades: { side: "any", count: 3 } });
  });

  it("leaves \"buy the last one\" and \"sell what I bought last\" on the trade paths", () => {
    expect(rulesIntent("buy the last one", CATALOG, {}).intent).toBe("buy");
    expect(rulesIntent("sell what I bought last", CATALOG, {}).intent).toBe("sell");
    expect(route("buy the last one").intent).not.toBe("last-trades");
    expect(route("sell what I bought last").intent).not.toBe("last-trades");
  });
});

describe("the answer", () => {
  it("names the last buy, from the vault's events only", () => {
    expect(lastTradesReply(ITEMS, { side: "buy", count: 1 })).toBe("You last bought 0.0263 TSLA for $10.00 on September 28.");
  });

  it("names the last sell", () => {
    expect(lastTradesReply(ITEMS, { side: "sell", count: 1 })).toBe("You last sold 0.0100 TSLA for $3.52 on September 28.");
  });

  it("lists the last 3 trades, newest first, skipping refusals and owner actions", () => {
    expect(lastTradesReply(ITEMS, { side: "any", count: 3 })).toBe(
      "Your last 3 trades: sold 0.0100 TSLA for $3.52 on September 28; bought 0.0263 TSLA for $10.00 on September 28; bought 0.0140 AMZN for $5.00 on September 27.",
    );
  });

  it("says so when there are none", () => {
    expect(lastTradesReply(ITEMS.filter((i) => i.type !== "Sold"), { side: "sell", count: 1 })).toBe("I don't see any sells in your vault's recent activity.");
  });

  it("with no vault linked, says so and points to setup (nothing is read)", async () => {
    const ctx = {} as never;
    const out = await replyFor(ctx, { intent: "last-trades", symbol: null, amount: null, trades: { side: "buy", count: 1 }, source: "rules" }, {}, undefined);
    expect(out.reply).toBe(NO_VAULT_TRADES);
    expect(NO_VAULT_TRADES).toContain("Get started");
  });
});
