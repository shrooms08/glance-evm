/**
 * The stock catalog: descriptive data (names, aliases) from data/catalog.json joined with on-chain addresses from the
 * deployment file. A stock the deployment skipped (no trustworthy price at deploy time) is left out.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Address } from "viem";

import type { Deployment } from "./deployment.js";

const catalogFileSchema = z.object({
  stocks: z.array(
    z.object({
      symbol: z.string().regex(/^[A-Z]{1,6}$/),
      name: z.string().min(1),
      legalName: z.string().min(1),
      names: z.array(z.string().min(2)),
      tickers: z.array(z.string().regex(/^[A-Z]{2,6}$/)),
      excludePhrases: z.array(z.string()),
      excludeNear: z.array(z.string()),
    }),
  ),
});

export type CatalogText = z.infer<typeof catalogFileSchema>["stocks"][number];

export interface CatalogEntry {
  symbol: string;
  name: string;
  legalName: string;
  aliases: string[];
  token: Address;
  tokenDecimals: number;
  tokenReal: boolean;
  tokenSource: string;
  feed: Address;
  feedReal: boolean;
  feedSource: string;
  priceSource: string;
  priceSourceKind: string;
}

export interface Catalog {
  entries: CatalogEntry[];
  text: CatalogText[];
  bySymbol: Map<string, CatalogEntry>;
  byToken: Map<string, CatalogEntry>;
}

export function loadCatalogText(path = resolve(import.meta.dirname, "../data/catalog.json")): CatalogText[] {
  return catalogFileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).stocks;
}

export function buildCatalog(deployment: Deployment, text: CatalogText[] = loadCatalogText()): Catalog {
  const entries: CatalogEntry[] = [];
  for (const t of text) {
    const s = deployment.stocks[t.symbol];
    if (!s || s.skipped) continue;
    entries.push({
      symbol: t.symbol,
      name: t.name,
      legalName: t.legalName,
      aliases: [...t.names, ...t.tickers.map((ticker) => `$${ticker}`), ...t.tickers],
      token: s.token,
      tokenDecimals: s.tokenDecimals,
      tokenReal: s.tokenReal,
      tokenSource: s.tokenSource,
      feed: s.feed,
      feedReal: s.feedReal,
      feedSource: s.feedSource,
      priceSource: s.priceSource,
      priceSourceKind: s.priceSourceKind,
    });
  }
  return {
    entries,
    text: text.filter((t) => entries.some((e) => e.symbol === t.symbol)),
    bySymbol: new Map(entries.map((e) => [e.symbol, e])),
    byToken: new Map(entries.map((e) => [e.token.toLowerCase(), e])),
  };
}
