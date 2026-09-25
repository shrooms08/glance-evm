/**
 * The headline journal: which article each buy came from. Kept only in this browser (chrome.storage.local), keyed by
 * the trade's transaction hash, and never sent anywhere: this module has no network code, and nothing else reads it
 * except the Portfolio view.
 *
 * Captured when a buy is placed from a page (hover card, panel or voice): the page's URL, title and site name, the
 * sentence the company was underlined in (at most 280 characters), the time, the symbol, the amount and the price at
 * the buy. Stored once the trade confirms.
 */
import { formatSignedPercent } from "@glance/core/format";
import { storage } from "wxt/utils/storage";

import { toRaw } from "./format";

export const MAX_SENTENCE = 280;

export interface PageContext {
  url: string;
  title: string;
  site: string;
  /** The sentence the company was underlined in, if it was on the page. */
  sentence: string | null;
}

export interface JournalEntry {
  txHash: string;
  explorerUrl: string;
  /** When the trade confirmed (ms). */
  at: number;
  symbol: string;
  /** Dollars spent, as typed ("10", "12.50"). */
  amount: string;
  /** The oracle price at the buy, as a decimal string ("378.025"). */
  priceAtBuy: string;
  /** Null: the buy wasn't placed from a page. */
  page: PageContext | null;
  /** A basket buy: one entry for the whole basket (keyed by its first leg's transaction), with every leg sent. */
  basket?: BasketBuy;
}

export interface BasketBuyLeg {
  symbol: string;
  /** Dollars spent on this leg ("6.00"). */
  amount: string;
  /** The quantity bought, as a decimal string ("0.0158"). */
  qty: string;
  priceAtBuy: string;
  txHash: string;
  explorerUrl: string;
}

export interface BasketBuy {
  id: string;
  name: string;
  legs: BasketBuyLeg[];
}

export const journalItem = storage.defineItem<Record<string, JournalEntry>>("local:journal", { fallback: {} });

export async function recordBuy(entry: JournalEntry): Promise<void> {
  const all = await journalItem.getValue();
  await journalItem.setValue({ ...all, [entry.txHash.toLowerCase()]: entry });
}

/** Every entry, newest first. */
export async function listJournal(): Promise<JournalEntry[]> {
  return Object.values(await journalItem.getValue()).sort((a, b) => b.at - a.at);
}

export async function entryFor(txHash: string): Promise<JournalEntry | null> {
  return (await journalItem.getValue())[txHash.toLowerCase()] ?? null;
}

export async function deleteEntry(txHash: string): Promise<void> {
  const all = { ...(await journalItem.getValue()) };
  delete all[txHash.toLowerCase()];
  await journalItem.setValue(all);
}

export async function clearJournal(): Promise<void> {
  await journalItem.setValue({});
}

/**
 * The sentence around [start, end) in `text`, trimmed to at most 280 characters (with an ellipsis where cut, keeping
 * the mention in view).
 */
export function sentenceAround(text: string, start: number, end: number): string {
  const flat = text.replace(/\s+/g, " ");
  // Map the offsets onto the whitespace-collapsed text.
  const before = text.slice(0, start).replace(/\s+/g, " ").length;
  const mentionLen = text.slice(start, end).replace(/\s+/g, " ").length;
  const s = Math.min(before, flat.length);
  const e = Math.min(s + mentionLen, flat.length);
  const boundary = /[.!?](?=\s|$)/g;
  let from = 0;
  for (const m of flat.slice(0, s).matchAll(boundary)) from = (m.index ?? 0) + 1;
  boundary.lastIndex = 0;
  const after = boundary.exec(flat.slice(e));
  const to = after ? e + (after.index ?? 0) + 1 : flat.length;
  const raw = flat.slice(from, to);
  const sentence = raw.trim();
  if (sentence.length <= MAX_SENTENCE) return sentence;
  // Too long: a window around the mention, with an ellipsis on each side that was cut.
  const mentionAt = s - from - (raw.length - raw.trimStart().length);
  const room = MAX_SENTENCE - 2;
  const winStart = Math.max(0, Math.min(mentionAt - Math.floor(room / 2), sentence.length - room));
  const cutEnd = winStart + room < sentence.length;
  return `${winStart > 0 ? "…" : ""}${sentence.slice(winStart, winStart + room)}${cutEnd ? "…" : ""}`;
}

const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, td, dd, article, section, div";

/** The page as it is now, with the sentence around `range` (a company's underline) if there is one. */
export function capturePage(doc: Document, range: Range | null): PageContext {
  let sentence: string | null = null;
  if (range) {
    const node = range.startContainer;
    const el = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest(BLOCK) ?? null;
    if (el) {
      const text = el.textContent ?? "";
      const pre = doc.createRange();
      pre.setStart(el, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      const start = pre.toString().length;
      sentence = sentenceAround(text, start, start + range.toString().length) || null;
    }
  }
  const og = doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim();
  return {
    url: doc.location.href,
    title: (doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? doc.title ?? "").trim().slice(0, 300),
    site: og || doc.location.hostname.replace(/^www\./, ""),
    sentence,
  };
}

/** "+2.3%" since the buy, from two decimal price strings (bigint maths). Null if either is missing. */
export function sinceThen(priceAtBuy: string, priceNow: string): string | null {
  try {
    const then = toRaw(priceAtBuy, 8);
    const now = toRaw(priceNow, 8);
    return formatSignedPercent(now - then, then);
  } catch {
    return null;
  }
}

/**
 * A confirmed buy, into the journal: `page` is where it was placed from (captured at the tap; null when it wasn't from
 * a page). Errors are swallowed: the journal never gets in the way of a trade.
 */
export async function recordTrade(
  page: Promise<PageContext | null> | PageContext | null,
  trade: { txHash: string; explorerUrl: string },
  buy: { symbol: string; amount: string; priceAtBuy: string },
  now: () => number = () => Date.now(),
): Promise<void> {
  try {
    const p = await page;
    await recordBuy({ txHash: trade.txHash, explorerUrl: trade.explorerUrl, at: now(), ...buy, page: p ?? null });
  } catch {
    // nothing: a failed journal write never affects the trade
  }
}

/**
 * A basket buy, into the journal: one entry, with every leg that went through (legs that weren't sent are left out).
 * Its symbol is the basket's name and its amount the dollars actually spent. Errors are swallowed, like recordTrade.
 */
export async function recordBasketBuy(
  page: Promise<PageContext | null> | PageContext | null,
  basket: { id: string; name: string },
  legs: ReadonlyArray<{ symbol: string; amount: string; status: string; txHash?: string; explorerUrl?: string; got?: string; priceAtBuy: string | null }>,
  now: () => number = () => Date.now(),
): Promise<JournalEntry | null> {
  try {
    const done = legs
      .filter((l) => l.status === "done" && l.txHash)
      .map((l) => ({ symbol: l.symbol, amount: l.amount, qty: (l.got ?? "").split(" ")[0] ?? "", priceAtBuy: l.priceAtBuy ?? "", txHash: l.txHash!, explorerUrl: l.explorerUrl ?? "" }));
    if (done.length === 0) return null;
    const cents = done.reduce((sum, l) => sum + Math.round(Number(l.amount) * 100), 0);
    const entry: JournalEntry = {
      txHash: done[0]!.txHash,
      explorerUrl: done[0]!.explorerUrl,
      at: now(),
      symbol: basket.name,
      amount: (cents / 100).toFixed(2),
      priceAtBuy: "",
      page: (await page) ?? null,
      basket: { id: basket.id, name: basket.name, legs: done },
    };
    await recordBuy(entry);
    return entry;
  } catch {
    return null;
  }
}

export interface BasketHolding {
  txHash: string;
  name: string;
  at: number;
  /** Dollars spent. */
  cost: number;
  /** What its legs are worth at today's prices (null: a price is missing). */
  valueNow: number | null;
  legs: Array<BasketBuyLeg & { valueNow: number | null }>;
  page: PageContext | null;
}

/**
 * The Portfolio's "Baskets" section: each basket bought, newest first, its legs, and what they're worth now. The
 * positions themselves are unchanged (a basket's shares are ordinary positions); this only groups the buys.
 */
export function basketHoldings(entries: readonly JournalEntry[], prices: Record<string, string>): BasketHolding[] {
  return entries
    .filter((e) => e.basket)
    .sort((a, b) => b.at - a.at)
    .map((e) => {
      const legs = e.basket!.legs.map((l) => {
        const p = prices[l.symbol];
        const q = Number(l.qty);
        return { ...l, valueNow: p !== undefined && l.qty !== "" && Number.isFinite(q) ? q * Number(p) : null };
      });
      const cost = legs.reduce((s, l) => s + Number(l.amount), 0);
      const valueNow = legs.every((l) => l.valueNow !== null) ? legs.reduce((s, l) => s + l.valueNow!, 0) : null;
      return { txHash: e.txHash, name: e.basket!.name, at: e.at, cost, valueNow, legs, page: e.page };
    });
}

/** Every transaction a journal entry covers (a basket's legs each have their own). */
export function entryHashes(e: JournalEntry): string[] {
  return e.basket ? e.basket.legs.map((l) => l.txHash.toLowerCase()) : [e.txHash.toLowerCase()];
}
