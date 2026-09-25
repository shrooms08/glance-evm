/**
 * Baskets in the extension: typed (and browser-fallback voice) parsing, the baskets kept in this browser, the one
 * signature over every leg, "buy the rest" sending only the passing legs, the journal's one entry per basket buy
 * ("Bought from" its page), and the Portfolio's Baskets section grouping the buys with their value now.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { recoverTypedDataAddress } from "viem";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_BASKETS } from "@glance/core/basket";
import { basketTypedData, bodyHash, SESSION_HEADERS } from "@glance/core/session";

import { Positions } from "../components/Portfolio";
import type { Portfolio } from "../lib/api-types";
import { allowedSymbols, deleteBasket, draftBasket, findBasket, legsToSend, listBaskets, saveBasket } from "../lib/baskets";
import { parseCommand, type CompanyAliases } from "../lib/commands";
import { basketHoldings, entryFor, listJournal, recordBasketBuy } from "../lib/journal";
import { resetSessionCacheForTests, sessionAddress, signBasket } from "../lib/session";

const companies: CompanyAliases[] = [
  { symbol: "TSLA", aliases: ["Tesla", "TSLA"] },
  { symbol: "AMZN", aliases: ["Amazon", "AMZN"] },
  { symbol: "PLTR", aliases: ["Palantir", "PLTR"] },
  { symbol: "NFLX", aliases: ["Netflix", "NFLX"] },
  { symbol: "AMD", aliases: ["Advanced Micro Devices", "AMD"] },
];
const ALLOWED = ["TSLA", "AMZN", "AMD", "NFLX", "PLTR"];
const parse = (s: string, baskets: string[] = ["Tech", "EV"]) => parseCommand(s, companies, baskets);

beforeEach(() => {
  fakeBrowser.reset();
  resetSessionCacheForTests();
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("parsing (typed, or voice read in the browser)", () => {
  it.each([
    ["buy $30 of the tech basket", "tech", "30"],
    ["buy thirty dollars of the Tech basket", "tech", "30"],
    ["buy the EV basket for $20", "ev", "20"],
    ["buy $30 of tech", "tech", "30"],
  ])("%s -> buy basket %s, $%s", (said, basket, amount) => {
    expect(parse(said)).toEqual({ kind: "buyBasket", basket, amount });
  });

  it("\"buy $30 of Tesla\" is still a single buy (a company, not a basket)", () => {
    expect(parse("buy $30 of Tesla")).toEqual({ kind: "buy", symbol: "TSLA", amount: "30" });
    // Without a basket of that name it isn't one either.
    expect(parse("buy $30 of tech", [])).not.toMatchObject({ kind: "buyBasket" });
  });

  it("make a basket called EV with Tesla and AMD, 50/50", () => {
    expect(parse("make a basket called EV with Tesla and AMD, 50/50")).toEqual({ kind: "makeBasket", name: "EV", symbols: ["TSLA", "AMD"], weights: [5000, 5000], unmatched: [] });
    expect(parse("create a basket named streaming with netflix, amazon and palantir")).toEqual({
      kind: "makeBasket",
      name: "Streaming",
      symbols: ["NFLX", "AMZN", "PLTR"],
      weights: null,
      unmatched: [],
    });
    expect(parse("make a basket called ev with tesla and amd 70 30")).toMatchObject({ name: "EV", weights: [7000, 3000] });
    expect(parse("make a basket called fruit with apple and tesla")).toMatchObject({ symbols: ["TSLA"], unmatched: ["apple"] });
  });

  it.each(["show my baskets", "my baskets", "baskets", "list my baskets"])("%s -> baskets", (said) => {
    expect(parse(said)).toEqual({ kind: "baskets" });
  });
});

describe("baskets in this browser", () => {
  it("built-ins first, then yours; saved, renamed, re-weighted, deleted", async () => {
    expect((await listBaskets(ALLOWED)).map((b) => b.name)).toEqual(["Tech"]);
    // The ETFs basket once SPY and QQQ are in the catalog.
    expect((await listBaskets([...ALLOWED, "SPY", "QQQ"])).map((b) => b.name)).toEqual(["Tech", "ETFs"]);
    const ev = await saveBasket(draftBasket("EV", ["TSLA", "AMD"], [5000, 5000]), ALLOWED);
    expect((await listBaskets(ALLOWED)).map((b) => b.name)).toEqual(["Tech", "EV"]);
    await saveBasket({ ...ev, name: "Electric", legs: [{ symbol: "TSLA", weightBps: 7000 }, { symbol: "AMD", weightBps: 3000 }] }, ALLOWED);
    const mine = (await listBaskets(ALLOWED))[1]!;
    expect(mine).toMatchObject({ id: ev.id, name: "Electric", legs: [{ symbol: "TSLA", weightBps: 7000 }, { symbol: "AMD", weightBps: 3000 }] });
    await deleteBasket(ev.id);
    expect((await listBaskets(ALLOWED)).map((b) => b.name)).toEqual(["Tech"]);
  });

  it("refuses bad weights, a name taken, a token the vault doesn't allow, and edits to Glance's own", async () => {
    await expect(saveBasket(draftBasket("EV", ["TSLA", "AMD"], [6000, 3000]), ALLOWED)).rejects.toThrow("The weights add up to 90%, not 100%.");
    await expect(saveBasket(draftBasket("tech", ["TSLA"], null), ALLOWED)).rejects.toThrow("You already have a basket called tech.");
    await expect(saveBasket(draftBasket("X", ["TSLA", "PLTR"], null), ["TSLA"])).rejects.toThrow("Your vault can't buy PLTR.");
    await expect(saveBasket(BUILT_IN_BASKETS[0]!, ALLOWED)).rejects.toThrow("can't be changed");
  });

  it("finds a basket by what was said", () => {
    const all = [...BUILT_IN_BASKETS];
    expect(findBasket("the tech basket", all)?.id).toBe("tech");
    expect(findBasket("TECH", all)?.id).toBe("tech");
    expect(findBasket("energy", all)).toBeNull();
  });

  it("the vault's allowed tokens (every catalog stock until the vault loads)", () => {
    expect(allowedSymbols({ positions: [{ symbol: "TSLA", allowed: true }, { symbol: "AMD", allowed: false }, { symbol: "NFLX" }] }, [])).toEqual(["TSLA", "NFLX"]);
    expect(allowedSymbols(null, [{ symbol: "TSLA" }])).toEqual(["TSLA"]);
  });
});

describe("buying", () => {
  it("\"Buy the other N\" sends only the legs that passed; a failing leg is never sent", () => {
    const report = {
      legs: [
        { symbol: "TSLA", amount: "6.00", ok: true },
        { symbol: "AMD", amount: "6.00", ok: false, reason: "AMD's price is too old to trade on." },
        { symbol: "NFLX", amount: "6.00", ok: true },
      ],
    };
    expect(legsToSend(report)).toEqual([
      { symbol: "TSLA", amount: "6.00" },
      { symbol: "NFLX", amount: "6.00" },
    ]);
  });

  it("one signature over every leg, by this browser's session key, with a fresh nonce each time", async () => {
    const body = { vault: "0x1111111111111111111111111111111111111111", legs: [{ symbol: "TSLA", amount: "15.00" }, { symbol: "AMD", amount: "15.00" }] };
    const now = 1_790_000_000_000;
    const a = await signBasket(body, now);
    expect(a.raw).toBe(JSON.stringify(body));
    const deadline = BigInt(a.headers[SESSION_HEADERS.deadline]!);
    const nonce = BigInt(a.headers[SESSION_HEADERS.nonce]!);
    const typed = basketTypedData({
      vault: body.vault as `0x${string}`,
      legs: body.legs.map((l) => ({ token: l.symbol, amount: l.amount, side: "buy" })),
      maxSlippageBps: 0,
      deadline,
      requestNonce: nonce,
      bodyHash: bodyHash(a.raw),
    });
    const signer = await recoverTypedDataAddress({ ...typed, signature: a.headers[SESSION_HEADERS.signature] as `0x${string}` });
    expect(signer).toBe(await sessionAddress());
    // A changed leg no longer matches the signature.
    const tampered = await recoverTypedDataAddress({ ...typed, message: { ...typed.message, legs: [typed.message.legs[0]!, { token: "AMD", amount: "95.00", side: "buy" }] }, signature: a.headers[SESSION_HEADERS.signature] as `0x${string}` });
    expect(tampered).not.toBe(signer);
    expect((await signBasket(body, now)).headers[SESSION_HEADERS.nonce]).not.toBe(a.headers[SESSION_HEADERS.nonce]);
  });
});

const TX = (n: number) => `0x${String(n).padStart(64, "0")}`;
const page = { url: "https://news.example/ev", title: "EV makers rally on tax credit news", site: "News Example", sentence: null };

describe("journal and portfolio", () => {
  it("one journal entry per basket buy, with the legs that went through and the page it was bought from", async () => {
    await recordBasketBuy(
      page,
      { id: "tech", name: "Tech" },
      [
        { symbol: "TSLA", amount: "6.00", status: "done", txHash: TX(1), explorerUrl: `https://explorer.example/tx/${TX(1)}`, got: "0.0158 TSLA", priceAtBuy: "380" },
        { symbol: "AMD", amount: "6.00", status: "reverted", txHash: TX(2), explorerUrl: "x", priceAtBuy: "150" },
        { symbol: "NFLX", amount: "6.00", status: "not-sent", priceAtBuy: "700" },
      ],
      () => 5_000,
    );
    const all = await listJournal();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ symbol: "Tech", amount: "6.00", at: 5_000, page: { title: "EV makers rally on tax credit news" } });
    expect(all[0]!.basket!.legs).toEqual([{ symbol: "TSLA", amount: "6.00", qty: "0.0158", priceAtBuy: "380", txHash: TX(1), explorerUrl: `https://explorer.example/tx/${TX(1)}` }]);
    expect(await entryFor(TX(1))).not.toBeNull();
    // Nothing went through: no entry.
    expect(await recordBasketBuy(page, { id: "tech", name: "Tech" }, [{ symbol: "AMD", amount: "6", status: "not-sent", priceAtBuy: null }])).toBeNull();
  });

  it("groups each basket bought with its legs and their value now", async () => {
    await recordBasketBuy(
      page,
      { id: "b-1", name: "EV" },
      [
        { symbol: "TSLA", amount: "10.00", status: "done", txHash: TX(3), explorerUrl: "e", got: "0.025 TSLA", priceAtBuy: "400" },
        { symbol: "AMD", amount: "10.00", status: "done", txHash: TX(4), explorerUrl: "e", got: "0.1 AMD", priceAtBuy: "100" },
      ],
      () => 1_000,
    );
    const [h] = basketHoldings(await listJournal(), { TSLA: "440", AMD: "90" });
    expect(h).toMatchObject({ name: "EV", cost: 20 });
    expect(h!.legs.map((l) => [l.symbol, l.valueNow])).toEqual([
      ["TSLA", 11],
      ["AMD", 9],
    ]);
    expect(h!.valueNow).toBe(20);
    // A missing price: that leg (and the total) says so rather than guessing.
    expect(basketHoldings(await listJournal(), { TSLA: "440" })[0]!.valueNow).toBeNull();
  });

  it("the Portfolio shows a Baskets section; positions stay as they are, each saying where its buy came from", async () => {
    await recordBasketBuy(
      page,
      { id: "b-1", name: "EV" },
      [
        { symbol: "TSLA", amount: "10.00", status: "done", txHash: TX(3), explorerUrl: "e", got: "0.025 TSLA", priceAtBuy: "400" },
        { symbol: "AMD", amount: "10.00", status: "done", txHash: TX(4), explorerUrl: "e", got: "0.1 AMD", priceAtBuy: "100" },
      ],
      () => 1_000,
    );
    const amt = (v: string) => ({ raw: "1", value: v, formatted: `$${v}` });
    const pos = (symbol: string, price: string, tx: string) => ({
      symbol,
      name: symbol,
      token: "0x0",
      qty: { raw: "1", value: "0.1", formatted: `0.1 ${symbol}` },
      avgCost: amt("1"),
      costBasis: amt("10"),
      price: { raw: "1", decimals: 8, value: price, formatted: `$${price}` },
      priceAge: { seconds: 60, text: "1m" },
      marketState: "OPEN",
      value: amt("11"),
      unrealizedPnl: { raw: "1", value: "1", formatted: "+$1" },
      unrealizedPnlPct: "+10%",
      unrealizedPnlBps: 1000,
      realizedPnl: amt("0"),
      transferredIn: null,
      lastBuy: { txHash: tx, timestamp: 1 },
    });
    const data = {
      vault: "0x1",
      usdg: { ...amt("80"), address: "0x2" },
      positions: [pos("TSLA", "440", TX(3)), pos("AMD", "90", TX(4))],
      totals: { value: amt("100"), stocksValue: amt("20"), costBasis: amt("20"), unrealizedPnl: amt("0"), unrealizedPnlPct: null, realizedPnl: { raw: "0", value: "0", formatted: "$0" } },
      sentence: "",
      asOf: 1,
    } as unknown as Portfolio;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Positions, { data, error: null, journal: await listJournal(), hasVault: true })));
    const section = host.querySelector("[data-basket-holding='EV']")!;
    expect(section.textContent).toContain("$20.00");
    expect(section.textContent).toContain("TSLA $11.00 · AMD $9.00");
    expect(host.querySelectorAll(".g-positions > .g-position").length).toBe(3); // 2 positions + 1 basket
    // Each position still says where it was bought, with its own leg's price.
    expect(host.textContent).toContain("Bought from: EV makers rally on tax credit news");
    expect(host.textContent).toContain("Since then: +10%");
    act(() => root.unmount());
  });
});
