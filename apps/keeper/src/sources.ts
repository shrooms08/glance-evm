/**
 * Loads config/price-sources.json: where each symbol's price comes from. The mainnet feed addresses live there, once,
 * and are shared with apps/api and script/fetch-prices.sh.
 */
import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "not an address")
  .transform((v) => getAddress(v) as Address);

const source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mainnet-mirror"), feed: address, description: z.string() }),
  z.object({ kind: z.literal("public-quote"), provider: z.literal("yahoo-finance"), description: z.string() }),
]);

const file = z.object({
  mainnet: z.object({ chainId: z.number().int(), name: z.string() }),
  sources: z.record(z.string(), source),
});

export type PriceSource = z.infer<typeof source>;
export type PriceSources = z.infer<typeof file>;

export function loadPriceSources(path: string): PriceSources {
  return file.parse(JSON.parse(readFileSync(path, "utf8")));
}

const deploymentStock = z.union([
  z.object({ skipped: z.literal(false), feed: address, token: address }),
  z.object({ skipped: z.literal(true) }),
]);
const deployment = z.object({ chainId: z.number().int(), stocks: z.record(z.string(), deploymentStock) });

/**
 * Each deployed testnet feed with its price source. A source whose feed isn't deployed yet (the ETF stand-ins before
 * `make deploy-etf-standins`) is simply not mirrored; a deployed feed with no source is an error.
 */
export function keeperSymbols(feeds: Record<string, Address>, sources: PriceSources, sourcesPath = "config/price-sources.json"): Array<{ symbol: string; testnetFeed: Address; source: PriceSource }> {
  return Object.entries(feeds).map(([symbol, testnetFeed]) => {
    const source = sources.sources[symbol];
    if (!source) throw new Error(`${symbol} is deployed but has no entry in ${sourcesPath}`);
    return { symbol, testnetFeed, source };
  });
}

/** Our testnet feed address for each listed symbol, from deployments/<chainId>.json. */
export function loadTestnetFeeds(path: string): { chainId: number; feeds: Record<string, Address> } {
  const d = deployment.parse(JSON.parse(readFileSync(path, "utf8")));
  const feeds: Record<string, Address> = {};
  for (const [symbol, s] of Object.entries(d.stocks)) if (!s.skipped) feeds[symbol] = s.feed;
  return { chainId: d.chainId, feeds };
}
