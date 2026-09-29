/**
 * Selling in the panel: the typed commands ("sell $10 of Tesla", "sell all my Palantir", "sell half my Tesla"), and the
 * sell card: the quote (what's sold, the USDG back, the live price and the vault's price), the confirm tap that sends
 * exactly the quoted shares, the receipt with its tx link, and each refusal on the guard card with a sell's next step.
 * Fakes only: a fake background answers the API calls; nothing is signed or sent.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Guard, Quote, Trade } from "../lib/api-types";
import { parseCommand } from "../lib/commands";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VAULT = "0x1111111111111111111111111111111111111111";
const glance = vi.hoisted(() => ({
  catalog: [{ symbol: "TSLA", name: "Tesla", legalName: "Tesla, Inc.", aliases: ["tesla"] }],
  vaultAddress: "0x1111111111111111111111111111111111111111",
  usdgDecimals: 6,
  voiceReplies: false,
  markUrl: "",
  setOrb: () => {},
  holdStill: () => () => {},
  refreshVault: async () => {},
  openConsole: () => {},
  openSettings: () => {},
  openSetup: () => {},
  openRelink: () => {},
}));
vi.mock("../components/context", () => ({ useGlance: () => glance }));
vi.mock("../lib/voiceClient", () => ({ speak: async () => "done" }));

/** The fake background: every API call the card makes, and what it answers. */
const calls: Array<{ method: string; path: string; body?: unknown }> = [];
const background = vi.hoisted(() => ({ reply: (_msg: { method: string; path: string; body?: unknown }): unknown => undefined }));
vi.mock("../lib/lifecycle", () => ({
  send: async (msg: { kind: string; method: string; path: string; body?: unknown }) => {
    calls.push({ method: msg.method, path: msg.path, body: msg.body });
    return background.reply(msg);
  },
}));

import { SellCard } from "../components/SellCard";

const amount = (raw: string, value: string, formatted: string) => ({ raw, value, formatted });
const QUOTE: Quote = {
  vault: VAULT,
  symbol: "TSLA",
  side: "sell",
  amountIn: amount("27027027027027027", "0.027027027027027027", "0.027 TSLA"),
  deskQuote: amount("9969999", "9.969999", "$9.97"),
  oracleImplied: amount("9999999", "9.999999", "$10.00"),
  spreadBps: 30,
  spread: "0.3%",
  minOut: amount("9969999", "9.969999", "$9.97"),
  price: { raw: "37000000000", decimals: 8, value: "370" },
  marketState: "OPEN",
  priceAgeSeconds: 10_800,
  live: { price: "371.00", source: "finnhub", quotedAt: 1_790_000_000, ageSeconds: 5, fetchedAt: 1_790_000_005_000 },
  drift: { checked: true, gapBps: 27, maxGapBps: 200, blocked: false, guard: null },
  preflight: { ok: true, simulatedAs: "0x2222222222222222222222222222222222222222" },
  sell: { basis: "usd", usd: "10", held: amount("1000000000000000000", "1", "1 TSLA"), heldValue: amount("370000000", "370", "$370"), value: amount("9999999", "9.999999", "$10.00") },
};
const TRADE: Trade = {
  txHash: `0x${"ab".repeat(32)}`,
  explorerUrl: `https://explorer.testnet.chain.robinhood.com/tx/0x${"ab".repeat(32)}`,
  symbol: "TSLA",
  side: "sell",
  filled: { tokensIn: amount("27027027027027027", "0.027027027027027027", "0.027 TSLA"), usdgOut: amount("9969999", "9.969999", "$9.97") },
  balancesAfter: {},
};
const guard = (code: string, message: string, detail: Guard["detail"] = {}): Guard => ({ code, error: code, message, args: {}, detail });
const ok = (data: unknown) => ({ ok: true, status: 200, data });

function render(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, unmount: () => act(() => root.unmount()) };
}
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const quotes = () => calls.filter((c) => c.path.startsWith("/quote")).map((c) => c.path);

beforeEach(() => {
  calls.length = 0;
  background.reply = (msg) => (msg.path.startsWith("/quote") ? ok(QUOTE) : msg.path === "/trade" ? ok(TRADE) : undefined);
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("typed sells", () => {
  const companies = [
    { symbol: "TSLA", aliases: ["Tesla"] },
    { symbol: "PLTR", aliases: ["Palantir"] },
  ];
  it.each([
    ["sell $10 of Tesla", { kind: "sell", symbol: "TSLA", amount: "10" }],
    ["Sell ten dollars of Tesla", { kind: "sell", symbol: "TSLA", amount: "10" }],
    ["sell twenty five dollars worth of TSLA", { kind: "sell", symbol: "TSLA", amount: "25" }],
    ["sell tesla for $10", { kind: "sell", symbol: "TSLA", amount: "10" }],
    ["Sell all my Palantir", { kind: "sell", symbol: "PLTR", fraction: "1" }],
    ["sell all of my palantir shares", { kind: "sell", symbol: "PLTR", fraction: "1" }],
    ["Sell half my Tesla", { kind: "sell", symbol: "TSLA", fraction: "0.5" }],
    ["get rid of half my Tesla", { kind: "sell", symbol: "TSLA", fraction: "0.5" }],
    ["sell my Tesla", { kind: "sell", symbol: "TSLA" }],
    ["Sell my Tech basket", { kind: "sellBasket", basket: "tech" }],
  ])("%s", (said, want) => {
    expect(parseCommand(said, companies)).toEqual(want);
  });

  it("a stock Glance doesn't trade is never a sell; buys are unchanged; 'sell it' confirms", () => {
    expect(parseCommand("sell all my Nokia", companies).kind).not.toBe("sell");
    expect(parseCommand("buy $10 of Tesla", companies)).toEqual({ kind: "buy", symbol: "TSLA", amount: "10" });
    expect(parseCommand("sell it", companies)).toEqual({ kind: "confirm" });
  });
});

describe("the sell card", () => {
  it("quotes $10 of Tesla, shows both prices and the USDG back, sends exactly the quoted shares, and shows the receipt", async () => {
    const { host, unmount } = render(createElement(SellCard, { symbol: "TSLA", spec: { usd: "10" } }));
    await settle();
    expect(quotes()).toEqual([`/quote?vault=${VAULT}&symbol=TSLA&side=sell&usd=10`]);
    const text = host.textContent!;
    expect(text).toContain("You hold 1 TSLA · about $370");
    expect(text).toContain("You sell0.027 TSLA · about $10.00");
    expect(text).toContain("You get about$9.97");
    expect(text).toContain("At least$9.97");
    expect(text).toContain("Market price$371.00 · live, 5s ago");
    expect(text).toContain("Vault trades at$370.00 · Chainlink · 3.0h old");
    expect(text).toContain("Passed every vault guard in a dry run");

    await act(async () => button(host, "Confirm sale of 0.027 TSLA")!.click());
    await settle();
    // The signed request names shares, the exact quoted count: never a dollar figure.
    expect(calls.find((c) => c.path === "/trade")!.body).toEqual({ vault: VAULT, symbol: "TSLA", side: "sell", amount: "0.027027027027027027" });
    expect(host.textContent).toContain("Sold 0.027 TSLA for $9.97");
    expect(host.textContent).toContain("the USDG is back in your vault");
    expect(host.querySelector("a")!.getAttribute("href")).toBe(TRADE.explorerUrl);
    unmount();
  });

  it("opened without an amount, it asks: $10, $25, Half, All, or dollars typed in", async () => {
    const { host, unmount } = render(createElement(SellCard, { symbol: "TSLA" }));
    expect(quotes()).toEqual([]);
    expect([...host.querySelectorAll(".g-chip")].map((b) => b.textContent)).toEqual(["$10", "$25", "Half", "All"]);
    await act(async () => button(host, "All")!.click());
    await settle();
    expect(quotes()).toEqual([`/quote?vault=${VAULT}&symbol=TSLA&side=sell&fraction=1`]);
    unmount();
  });

  it("nothing held: the guard card says so, with nothing to press but OK, and nothing is sent", async () => {
    const message = "You don't hold any Tesla in your vault, so there's nothing to sell.";
    background.reply = () => ({ ok: false, status: 422, offline: false, code: "NOTHING_HELD", message, guard: guard("NOTHING_HELD", message) });
    const { host, unmount } = render(createElement(SellCard, { symbol: "TSLA", spec: { fraction: "1" } }));
    await settle();
    expect(host.textContent).toContain("Nothing to sell");
    expect(host.textContent).toContain(message);
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["OK"]);
    expect(calls.some((c) => c.path === "/trade")).toBe(false);
    unmount();
  });

  it("the closed market's $25 cap: the vault's rule in plain words, and 'Sell $25 worth instead' quotes that", async () => {
    const message = "The market is closed, so each trade is capped at $25. Want me to sell $25 worth instead?";
    background.reply = (msg) =>
      msg.path.includes("usd=40")
        ? ok({ ...QUOTE, marketState: "CLOSED", preflight: { ok: false, simulatedAs: "0x2", guard: guard("PER_TRADE_CAP", message, { requested: "40000000", limit: "25000000", suggestedAmount: "25000000" }) } })
        : ok(QUOTE);
    const { host, unmount } = render(createElement(SellCard, { symbol: "TSLA", spec: { usd: "40" } }));
    await settle();
    expect(host.textContent).toContain(message);
    await act(async () => button(host, "Sell $25 worth instead")!.click());
    await settle();
    expect(quotes().at(-1)).toBe(`/quote?vault=${VAULT}&symbol=TSLA&side=sell&usd=25`);
    unmount();
  });

  it("more than the vault holds: 'Sell all instead'", async () => {
    background.reply = (msg) =>
      msg.path.includes("usd=500")
        ? ok({ ...QUOTE, preflight: { ok: false, simulatedAs: "0x2", guard: guard("INSUFFICIENT_BALANCE", "You only hold 1 TSLA in the vault.") } })
        : ok(QUOTE);
    const { host, unmount } = render(createElement(SellCard, { symbol: "TSLA", spec: { usd: "500" } }));
    await settle();
    expect(host.textContent).toContain("You don't hold that much");
    await act(async () => button(host, "Sell all instead")!.click());
    await settle();
    expect(quotes().at(-1)).toBe(`/quote?vault=${VAULT}&symbol=TSLA&side=sell&fraction=1`);
    unmount();
  });

  it("the drift guard stops it before the confirm step", async () => {
    const message = "The on-chain price is behind the market right now, so I won't trade Tesla yet.";
    background.reply = () => ok({ ...QUOTE, drift: { checked: true, gapBps: 500, maxGapBps: 200, blocked: true, guard: guard("PRICE_DRIFT", message, { livePrice: "$390.00", oraclePrice: "$370.00", gap: "5.4%" }) } });
    const { host, unmount } = render(createElement(SellCard, { symbol: "TSLA", spec: { usd: "10" } }));
    await settle();
    expect(host.textContent).toContain("The on-chain price is behind the market");
    expect(button(host, "Confirm")).toBeUndefined();
    unmount();
  });
});
