/**
 * Baskets in this browser: Glance's built-in ones (packages/core/src/basket.ts) and the user's own, kept in
 * chrome.storage.local. A basket is only a list of stocks and weights: buying one is a separate buy per leg, each
 * preflighted and checked by the vault (see useBasketFlow), so nothing here can move money.
 */
import { basketProblems, BUILT_IN_BASKETS, equalWeights, type Basket, type BasketLeg } from "@glance/core/basket";
import { storage } from "wxt/utils/storage";

export const userBaskets = storage.defineItem<Basket[]>("local:baskets", { fallback: [] });

/** The built-in baskets first, then the user's, in the order made. */
export async function listBaskets(): Promise<Basket[]> {
  const mine = await userBaskets.getValue().catch(() => [] as Basket[]);
  return [...BUILT_IN_BASKETS, ...mine];
}

const key = (name: string) =>
  name
    .toLowerCase()
    .replace(/\bbasket\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** "the tech basket", "Tech", "tech basket" -> the Tech basket. Exact names only (after dropping "the" and "basket"). */
export function findBasket(name: string, baskets: readonly Basket[]): Basket | null {
  const want = key(name.replace(/^\s*(the|my)\s+/i, ""));
  return baskets.find((b) => key(b.name) === want) ?? null;
}

export function newBasketId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `b-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Saves a user basket (new or edited). Throws the first problem, in plain words. */
export async function saveBasket(b: Basket, allowed: readonly string[]): Promise<Basket> {
  if (b.builtIn || BUILT_IN_BASKETS.some((x) => x.id === b.id)) throw new Error("Glance's own baskets can't be changed. Make your own instead.");
  const clean: Basket = { id: b.id, name: b.name.trim(), legs: b.legs.map((l) => ({ symbol: l.symbol, weightBps: l.weightBps })) };
  const problems = basketProblems(clean, allowed);
  const all = await listBaskets();
  if (all.some((x) => x.id !== clean.id && key(x.name) === key(clean.name))) problems.unshift(`You already have a basket called ${clean.name}.`);
  if (problems.length) throw new Error(problems[0]);
  const mine = await userBaskets.getValue();
  const at = mine.findIndex((x) => x.id === clean.id);
  await userBaskets.setValue(at >= 0 ? mine.map((x) => (x.id === clean.id ? clean : x)) : [...mine, clean]);
  return clean;
}

export async function deleteBasket(id: string): Promise<void> {
  await userBaskets.setValue((await userBaskets.getValue()).filter((b) => b.id !== id));
}

/** A new basket from names and (optionally) a split: equal weights when no split was given. */
export function draftBasket(name: string, symbols: readonly string[], weights: readonly number[] | null): Basket {
  const legs: BasketLeg[] = weights && weights.length === symbols.length ? symbols.map((symbol, i) => ({ symbol, weightBps: weights[i]! })) : equalWeights(symbols);
  return { id: newBasketId(), name: name.trim(), legs };
}

/** "Tesla 50%, AMD 50%": a basket's legs in words. */
export function describeLegs(legs: readonly BasketLeg[]): string {
  return legs.map((l) => `${l.symbol} ${percent(l.weightBps)}`).join(", ");
}

export const percent = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

/** The legs a basket buy sends: only the ones that passed the preflight ("Buy the other N"), never a failing one. */
export function legsToSend(report: { legs: ReadonlyArray<{ symbol: string; amount: string; ok: boolean }> }): Array<{ symbol: string; amount: string }> {
  return report.legs.filter((l) => l.ok).map((l) => ({ symbol: l.symbol, amount: l.amount }));
}

/** The symbols the vault allows (every catalog stock until the vault has loaded; the preflight checks again). */
export function allowedSymbols(vault: { positions: ReadonlyArray<{ symbol: string; allowed?: boolean }> } | null, catalog: ReadonlyArray<{ symbol: string }>): string[] {
  return vault ? vault.positions.filter((p) => p.allowed !== false).map((p) => p.symbol) : catalog.map((c) => c.symbol);
}
