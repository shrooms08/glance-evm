/**
 * Public quote for stocks with no Chainlink feed (NFLX). Uses the quote's own market timestamp as updatedAt, for the
 * same reason the mainnet mirror copies updatedAt: outside market hours the quote stops moving, and so does our feed.
 */
import type { Round } from "./mirror.ts";

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";

/** "72.16" -> 7216000000n (8 decimals). Returns null for anything that is not a positive plain decimal. */
export function toPrice8(value: unknown): bigint | null {
  const text = typeof value === "number" ? value.toString() : typeof value === "string" ? value : "";
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const fraction = (m[2] ?? "").slice(0, 8).padEnd(8, "0");
  const price = BigInt(m[1]!) * 100_000_000n + BigInt(fraction);
  return price > 0n ? price : null;
}

export interface Quote extends Round {
  provider: string;
  display: string;
}

export async function fetchYahooQuote(symbol: string, fetchImpl: typeof fetch = fetch): Promise<Quote | null> {
  const res = await fetchImpl(`${YAHOO}/${encodeURIComponent(symbol)}?interval=1d&range=1d`, {
    headers: { "user-agent": "Mozilla/5.0 (glance-keeper)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: unknown; regularMarketTime?: unknown } }> } };
  const meta = body.chart?.result?.[0]?.meta;
  const answer = toPrice8(meta?.regularMarketPrice);
  const time = Number(meta?.regularMarketTime);
  if (answer === null || !Number.isInteger(time) || time <= 0) return null;
  return { answer, updatedAt: BigInt(time), provider: "Yahoo Finance", display: String(meta?.regularMarketPrice) };
}
