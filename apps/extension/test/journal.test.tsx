/**
 * The headline journal: captured when a buy is placed from a page, stored by transaction hash once it confirms, kept in
 * chrome.storage.local only (never sent over the network), and deletable. Plus the Portfolio view's rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Journal, Positions } from "../components/Portfolio";
import { parseCommand } from "../lib/commands";
import type { Portfolio } from "../lib/api-types";
import { capturePage, clearJournal, deleteEntry, entryFor, listJournal, MAX_SENTENCE, recordTrade, sentenceAround, sinceThen, type JournalEntry } from "../lib/journal";

const TX1 = "0x15eac3a815516dee5bb1e130e475e9e1be4610c74738865d3074fb036371324a";
const TX2 = "0x9045aa0000000000000000000000000000000000000000000000000000001234";

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fakeBrowser.reset();
  fetchSpy = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(fakeBrowser.runtime, "sendMessage");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

function article() {
  document.title = "Tesla deliveries beat estimates | Reuters";
  const og = document.createElement("meta");
  og.setAttribute("property", "og:site_name");
  og.setAttribute("content", "Reuters");
  document.head.append(og);
  const p = document.createElement("p");
  p.textContent = "Markets were quiet on Monday. Shares of Tesla rose 3% after deliveries beat estimates. Other carmakers fell.";
  document.body.append(p);
  const text = p.firstChild!;
  const at = p.textContent.indexOf("Tesla");
  const range = document.createRange();
  range.setStart(text, at);
  range.setEnd(text, at + "Tesla".length);
  return range;
}

describe("capture", () => {
  it("takes the page, its site name, and the sentence the company was underlined in", () => {
    const page = capturePage(document, article());
    expect(page).toEqual({
      url: document.location.href,
      title: "Tesla deliveries beat estimates | Reuters",
      site: "Reuters",
      sentence: "Shares of Tesla rose 3% after deliveries beat estimates.",
    });
  });

  it("keeps the sentence to 280 characters, with the company in view", () => {
    const long = `${"word ".repeat(100)}Tesla ${"more ".repeat(100)}end.`;
    const at = long.indexOf("Tesla");
    const s = sentenceAround(long, at, at + 5);
    expect(s.length).toBeLessThanOrEqual(MAX_SENTENCE);
    expect(s).toContain("Tesla");
    expect(s.startsWith("…") && s.endsWith("…")).toBe(true);
  });

  it("is recorded when the buy confirms, keyed by its transaction hash", async () => {
    const page = capturePage(document, article());
    await recordTrade(page, { txHash: TX1, explorerUrl: `https://explorer.example/tx/${TX1}` }, { symbol: "TSLA", amount: "10", priceAtBuy: "378.025" }, () => 1_000);
    const stored = (await fakeBrowser.storage.local.get("journal")).journal as Record<string, JournalEntry>;
    expect(Object.keys(stored)).toEqual([TX1.toLowerCase()]);
    expect(await entryFor(TX1)).toMatchObject({ symbol: "TSLA", amount: "10", priceAtBuy: "378.025", at: 1_000, page: { site: "Reuters" } });
  });

  it("a buy not placed from a page is recorded without one", async () => {
    await recordTrade(null, { txHash: TX2, explorerUrl: "x" }, { symbol: "AMD", amount: "25", priceAtBuy: "600" });
    expect((await entryFor(TX2))?.page).toBeNull();
  });

  it("never touches the network: no fetch, no message to the API, and no network code in the module", async () => {
    await recordTrade(capturePage(document, article()), { txHash: TX1, explorerUrl: "x" }, { symbol: "TSLA", amount: "10", priceAtBuy: "378" });
    await listJournal();
    await deleteEntry(TX1);
    await clearJournal();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fakeBrowser.runtime.sendMessage).not.toHaveBeenCalled();
    const source = readFileSync(join(import.meta.dirname, "../lib/journal.ts"), "utf8");
    expect(source).not.toMatch(/\bfetch\(|sendMessage|from "\.\/api"|XMLHttpRequest|WebSocket/);
    expect(source).toContain('"local:journal"');
  });
});

describe("list, delete, clear", () => {
  it("lists newest first, deletes one, and clears all", async () => {
    await recordTrade(null, { txHash: TX1, explorerUrl: "x" }, { symbol: "TSLA", amount: "10", priceAtBuy: "378" }, () => 1_000);
    await recordTrade(null, { txHash: TX2, explorerUrl: "y" }, { symbol: "AMD", amount: "25", priceAtBuy: "600" }, () => 2_000);
    expect((await listJournal()).map((e) => e.symbol)).toEqual(["AMD", "TSLA"]);
    await deleteEntry(TX2);
    expect((await listJournal()).map((e) => e.symbol)).toEqual(["TSLA"]);
    await clearJournal();
    expect(await listJournal()).toEqual([]);
  });

  it("says how the price moved since the buy, in bigint", () => {
    expect(sinceThen("378.025", "389.36575")).toBe("+3%");
    expect(sinceThen("400", "396")).toBe("-1%");
    expect(sinceThen("nope", "1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The Portfolio view's rows
// ---------------------------------------------------------------------------------------------------------------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function render(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, unmount: () => act(() => root.unmount()) };
}

const amount = (formatted: string, raw = "1") => ({ raw, value: raw, formatted });
const position = (over: Partial<Portfolio["positions"][number]> = {}): Portfolio["positions"][number] => ({
  symbol: "TSLA",
  name: "Tesla",
  token: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E",
  qty: amount("0.0262 TSLA"),
  avgCost: amount("$381.07"),
  costBasis: amount("$10"),
  price: { raw: "37802500000", decimals: 8, value: "378.025", formatted: "$378.03" },
  priceAge: { seconds: 13_338, text: "4 hours" },
  marketState: "OPEN",
  value: amount("$9.92"),
  unrealizedPnl: amount("-$0.08", "-79860"),
  unrealizedPnlPct: "-0.8%",
  unrealizedPnlBps: -79,
  realizedPnl: amount("$0", "0"),
  transferredIn: null,
  lastBuy: { txHash: TX1, timestamp: 1 },
  ...over,
});
const portfolio = (positions: Portfolio["positions"]): Portfolio => ({
  vault: "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113",
  usdg: { ...amount("$110"), address: "0x7E955252E15c84f5768B83c41a71F9eba181802F" },
  positions,
  totals: { value: amount("$119.92"), stocksValue: amount("$9.92"), costBasis: amount("$10"), unrealizedPnl: amount("-$0.08"), unrealizedPnlPct: "-0.8%", realizedPnl: amount("$0", "0") },
  sentence: "",
  asOf: 0,
});

describe("Portfolio view", () => {
  it("shows cash, value, PnL in $ and % (muted red when down, lime when up) and the price's age", () => {
    const { host, unmount } = render(createElement(Positions, { data: portfolio([position(), position({ symbol: "AMD", unrealizedPnl: amount("+$1.40"), unrealizedPnlPct: "+2.3%", lastBuy: null })]), error: null, journal: [], hasVault: true }));
    expect(host.textContent).toContain("USDG cash$110");
    expect(host.textContent).toContain("-$0.08 · -0.8%");
    expect(host.querySelectorAll(".g-down").length).toBeGreaterThan(0);
    expect([...host.querySelectorAll(".g-up")].some((e) => e.textContent?.includes("+$1.40"))).toBe(true);
    expect(host.textContent).toContain("3.7h old");
    unmount();
  });

  it("empty: 'No stocks yet. Everything's in USDG.'", () => {
    const { host, unmount } = render(createElement(Positions, { data: portfolio([]), error: null, journal: [], hasVault: true }));
    expect(host.textContent).toContain("No stocks yet. Everything's in USDG.");
    unmount();
  });

  it("each position says which headline its latest buy came from, and how it moved since; or that it wasn't from a page", () => {
    const entry: JournalEntry = { txHash: TX1, explorerUrl: "x", at: 1, symbol: "TSLA", amount: "10", priceAtBuy: "370.61", page: { url: "https://reuters.example/tesla", title: "Tesla deliveries beat estimates", site: "Reuters", sentence: null } };
    const { host, unmount } = render(createElement(Positions, { data: portfolio([position()]), error: null, journal: [entry], hasVault: true }));
    const link = host.querySelector(".g-bought-from a") as HTMLAnchorElement;
    expect(link.textContent).toBe("Tesla deliveries beat estimates");
    expect(link.href).toBe("https://reuters.example/tesla");
    expect(host.textContent).toContain("· Reuters · Since then: +2%");
    unmount();
    const outside = render(createElement(Positions, { data: portfolio([position()]), error: null, journal: [], hasVault: true }));
    expect(outside.host.textContent).toContain("Bought outside a page");
    outside.unmount();
  });

  it("the journal lists headline, site, symbol, amount, price then vs now, the tx link, and deletes", () => {
    const onDelete = vi.fn();
    const onClear = vi.fn();
    const entry: JournalEntry = { txHash: TX1, explorerUrl: `https://explorer.example/tx/${TX1}`, at: 1, symbol: "TSLA", amount: "10", priceAtBuy: "370", page: { url: "https://reuters.example/t", title: "Tesla deliveries beat estimates", site: "Reuters", sentence: "Shares of Tesla rose 3%." } };
    const { host, unmount } = render(createElement(Journal, { entries: [entry], prices: { TSLA: "378.025" }, onDelete, onClear }));
    expect(host.textContent).toContain("Tesla deliveries beat estimates");
    expect(host.textContent).toContain("Reuters · TSLA $10 at $370.00 · now $378.03 (+2.2%)");
    expect((host.querySelector('a[href*="explorer"]') as HTMLAnchorElement).href).toContain(TX1);
    act(() => (host.querySelector('[aria-label="Delete the TSLA entry"]') as HTMLButtonElement).click());
    expect(onDelete).toHaveBeenCalledWith(TX1);
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear journal")!.click());
    expect(onClear).toHaveBeenCalled();
    unmount();
  });
});

describe("typed questions", () => {
  const companies = [
    { symbol: "TSLA", aliases: ["Tesla"] },
    { symbol: "AMD", aliases: ["AMD", "Advanced Micro Devices"] },
  ];
  it("'how am I doing', 'what do I own', 'show my portfolio' open the portfolio", () => {
    for (const t of ["how am I doing?", "what do I own", "show my portfolio"]) expect(parseCommand(t, companies)).toEqual({ kind: "portfolio" });
  });
  it("'why did Tesla move?' asks why it moved", () => {
    expect(parseCommand("why did Tesla move?", companies)).toEqual({ kind: "why", symbol: "TSLA" });
    expect(parseCommand("why is AMD down today", companies)).toEqual({ kind: "why", symbol: "AMD" });
  });
});
