/**
 * Live market prices, for display only (the console's Prices page, the extension's cards and voice) and for the drift
 * guard. The vault never trades on these: it trades on its oracle (the Chainlink feeds mirrored from mainnet), and the
 * keeper stays a pure Chainlink mirror.
 *
 *   source     Finnhub's REST quote (FINNHUB_API_KEY, sent as a header, never in a logged URL); if Finnhub fails for a
 *              symbol, the public Yahoo Finance quote (the one the keeper uses for NFLX). Each quote says which.
 *   cadence    every 15s while the US market is open (Mon-Fri 9:30-16:00 New York), every 5 minutes while it's closed:
 *              7 symbols every 15s is 28 calls a minute, under Finnhub's free 60.
 *   freshness  a quote is served while its last fetch is recent (twice the current cadence, plus 30s); older, it's
 *              "unavailable" (the drift guard then doesn't block, and says so in the log).
 */
import { fetchYahooQuote } from "keeper/quote";

export type LiveSource = "finnhub" | "yahoo";

export interface LiveQuote {
  symbol: string;
  /** US dollars, as the provider quoted it. */
  price: number;
  source: LiveSource;
  /** The quote's own time (unix seconds): the last trade the provider saw. */
  quotedAt: number;
  /** When Glance fetched it (unix ms). */
  fetchedAt: number;
}

export const OPEN_POLL_MS = 15_000;
export const CLOSED_POLL_MS = 5 * 60_000;

/** Regular US trading hours, in New York time: Monday to Friday, 9:30 to 16:00 (holidays count as open: a faster poll, no harm). */
export function usMarketOpen(nowMs: number): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(nowMs))
      .map((p) => [p.type, p.value]),
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export interface LiveQuotesOptions {
  symbols: readonly string[];
  finnhubKey?: string;
  fetch?: typeof fetch;
  /** The fallback (tests pass their own). */
  yahoo?: (symbol: string) => Promise<{ price: number; quotedAt: number } | null>;
  now?: () => number;
  log?: (line: string) => void;
}

export class LiveQuotes {
  private readonly quotes = new Map<string, LiveQuote>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private refreshing: Promise<void> | null = null;
  private readonly o: Required<Omit<LiveQuotesOptions, "finnhubKey">> & { finnhubKey?: string };

  constructor(o: LiveQuotesOptions) {
    const doFetch = o.fetch ?? fetch;
    this.o = {
      symbols: o.symbols,
      finnhubKey: o.finnhubKey,
      fetch: doFetch,
      yahoo:
        o.yahoo ??
        (async (symbol) => {
          const q = await fetchYahooQuote(symbol, doFetch).catch(() => null);
          return q ? { price: Number(q.answer) / 1e8, quotedAt: Number(q.updatedAt) } : null;
        }),
      now: o.now ?? Date.now,
      log: o.log ?? ((l) => console.log(l)),
    };
  }

  marketOpen(): boolean {
    return usMarketOpen(this.o.now());
  }

  pollMs(): number {
    return this.marketOpen() ? OPEN_POLL_MS : CLOSED_POLL_MS;
  }

  /** A symbol's quote, or null when there is none or its last fetch is too old to call live. */
  get(symbol: string): LiveQuote | null {
    const q = this.quotes.get(symbol.toUpperCase());
    if (!q) return null;
    return this.o.now() - q.fetchedAt <= 2 * this.pollMs() + 30_000 ? q : null;
  }

  all(): LiveQuote[] {
    return this.o.symbols.map((s) => this.get(s)).filter((q): q is LiveQuote => q !== null);
  }

  private async finnhub(symbol: string): Promise<{ price: number; quotedAt: number } | null> {
    if (!this.o.finnhubKey) return null;
    const res = await this.o.fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`, {
      headers: { "X-Finnhub-Token": this.o.finnhubKey },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) throw new Error(`Finnhub answered ${res.status}`);
    const body = (await res.json()) as { c?: unknown; t?: unknown };
    const price = Number(body.c);
    const quotedAt = Number(body.t);
    // An unknown symbol answers zeros.
    if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(quotedAt) || quotedAt <= 0) throw new Error("Finnhub: no quote");
    return { price, quotedAt };
  }

  /** One pass over every symbol: Finnhub, else Yahoo. A symbol neither answers keeps its last quote (until it ages out). */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      const failures: string[] = [];
      await Promise.all(
        this.o.symbols.map(async (symbol) => {
          let q: { price: number; quotedAt: number } | null = null;
          let source: LiveSource = "finnhub";
          try {
            q = await this.finnhub(symbol);
          } catch (err) {
            failures.push(`${symbol} (${(err as Error).message})`);
          }
          if (!q) {
            source = "yahoo";
            q = await this.o.yahoo(symbol).catch(() => null);
          }
          if (q) this.quotes.set(symbol, { symbol, price: q.price, quotedAt: q.quotedAt, source, fetchedAt: this.o.now() });
        }),
      );
      // One line per pass that had trouble (never the key: it's in a header, and messages carry only the status).
      if (failures.length) this.o.log(`[quotes] Finnhub failed for ${failures.join(", ")}; used Yahoo where it answered`);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      await this.refresh().catch(() => {});
      if (this.running) this.timer = setTimeout(() => void tick(), this.pollMs());
    };
    void tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }
}

/** How far the live price is from the vault's oracle price, in basis points of the oracle price. */
export function gapBps(live: number, oracle: number): number {
  return oracle > 0 ? (Math.abs(live - oracle) / oracle) * 10_000 : Number.POSITIVE_INFINITY;
}
