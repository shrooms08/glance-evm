/**
 * Baskets: several stocks bought as one, by weight. A basket is { id, name, legs: [{ symbol, weightBps }] } with the
 * weights summing to 10,000 (100%), using only tokens the vault allows. No contract knows about baskets: a basket buy is
 * one ordinary vault buy per leg, each checked by the vault's own guards.
 *
 * The plan for a total: each leg gets total x weight, rounded down to the cent; the cents left over go to the largest
 * leg (the first one, on a tie), so the legs add up to the total exactly.
 */
export interface BasketLeg {
  symbol: string;
  weightBps: number;
}

export interface Basket {
  id: string;
  name: string;
  legs: BasketLeg[];
  /** Built into Glance (can't be edited or deleted). */
  builtIn?: boolean;
}

export const FULL_WEIGHT = 10_000;
export const MAX_LEGS = 10;

/** Equal weights for these symbols, summing to 10,000 (the first legs take the leftover basis points). */
export function equalWeights(symbols: readonly string[]): BasketLeg[] {
  const base = Math.floor(FULL_WEIGHT / symbols.length);
  let extra = FULL_WEIGHT - base * symbols.length;
  return symbols.map((symbol) => ({ symbol, weightBps: base + (extra-- > 0 ? 1 : 0) }));
}

/** Glance's own baskets. */
export const BUILT_IN_BASKETS: readonly Basket[] = [{ id: "tech", name: "Tech", legs: equalWeights(["TSLA", "AMZN", "AMD", "NFLX", "PLTR"]), builtIn: true }];

/** What's wrong with a basket, in plain words (empty: it's fine). */
export function basketProblems(b: Pick<Basket, "name" | "legs">, allowed: readonly string[]): string[] {
  const out: string[] = [];
  if (!b.name.trim()) out.push("Give the basket a name.");
  if (b.name.trim().length > 40) out.push("Keep the name under 40 characters.");
  if (b.legs.length === 0) out.push("Add at least one stock.");
  if (b.legs.length > MAX_LEGS) out.push(`A basket holds at most ${MAX_LEGS} stocks.`);
  const seen = new Set<string>();
  for (const l of b.legs) {
    if (seen.has(l.symbol)) out.push(`${l.symbol} is in the basket twice.`);
    seen.add(l.symbol);
    if (!allowed.includes(l.symbol)) out.push(`Your vault can't buy ${l.symbol}.`);
    if (!Number.isInteger(l.weightBps) || l.weightBps <= 0) out.push(`${l.symbol}'s weight must be more than 0%.`);
  }
  const sum = b.legs.reduce((s, l) => s + l.weightBps, 0);
  if (b.legs.length > 0 && sum !== FULL_WEIGHT) out.push(`The weights add up to ${(sum / 100).toFixed(2).replace(/\.00$/, "")}%, not 100%.`);
  return out;
}

export interface PlannedLeg {
  symbol: string;
  weightBps: number;
  /** Dollars, as a decimal string with cents ("6.00"). */
  amount: string;
}

/** "30" -> 3000 cents; "12.5" -> 1250. Null for anything that isn't a positive dollar amount with at most 2 decimals. */
export function toCents(amount: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim().replace(/^\$/, ""));
  if (!m) return null;
  const cents = BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  return cents > 0n ? cents : null;
}

export const fromCents = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;

/** Each leg's amount: total x weight, rounded down to the cent; the remainder to the largest leg. */
export function planBasket(total: string, legs: readonly BasketLeg[]): PlannedLeg[] {
  const cents = toCents(total);
  if (cents === null) throw new Error("The total must be a dollar amount, like 30 or 12.50.");
  const parts = legs.map((l) => (cents * BigInt(l.weightBps)) / BigInt(FULL_WEIGHT));
  const left = cents - parts.reduce((s, p) => s + p, 0n);
  let largest = 0;
  legs.forEach((l, i) => {
    if (l.weightBps > legs[largest]!.weightBps) largest = i;
  });
  parts[largest] = parts[largest]! + left;
  return legs.map((l, i) => ({ symbol: l.symbol, weightBps: l.weightBps, amount: fromCents(parts[i]!) }));
}

/** "Tesla and AMD, 50/50" -> [5000, 5000]; "60 40" -> [6000, 4000]. Null when the numbers don't fit the legs or 100%. */
export function parseSplit(text: string, legs: number): number[] | null {
  const nums = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%?/g)].map((m) => Number(m[1]));
  if (nums.length !== legs) return null;
  const bps = nums.map((n) => Math.round(n * 100));
  return bps.reduce((s, n) => s + n, 0) === FULL_WEIGHT ? bps : null;
}
