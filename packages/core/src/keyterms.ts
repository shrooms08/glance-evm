/**
 * The words speech recognition should expect (keyterms prompting): every stock Glance can trade, by ticker and by name,
 * Glance's own words, and the command verbs, plus (from the extension) the user's basket names for that session.
 *
 * AssemblyAI's limits (docs: streaming/prompting-and-keyterms): at most 100 keyterms a session ("requests with more
 * than 100 keyterms return an error") and 50 characters each ("longer than 50 characters are ignored"). The list is cut
 * to fit, with room kept for the session's basket names. Deepgram takes the same list (its `keyterm` parameter).
 */
export const KEYTERM_MAX = 100;
export const KEYTERM_MAX_CHARS = 50;
/** Kept free for the user's own basket names, which come with each session. */
export const KEYTERM_SESSION_ROOM = 10;

/** Glance's own words, which a general model hears as something else ("glance" is fine; "USDG" is not). */
export const GLANCE_KEYTERMS = ["Glance", "basket", "portfolio", "vault", "USDG"] as const;
/** The command verbs ("by ten dollars" is the classic slip for "buy"). */
export const COMMAND_KEYTERMS = ["buy", "compare", "chart"] as const;

export interface KeytermCompany {
  symbol: string;
  name: string;
  /** Other names ("Nasdaq-100", "S&P 500 ETF"); cashtags and long legal names are left out. */
  aliases?: readonly string[];
}

const clean = (t: string) => t.replace(/\s+/g, " ").trim();
const usable = (t: string) => t.length > 0 && t.length <= KEYTERM_MAX_CHARS && !t.startsWith("$") && !/[,()]/.test(t);

/**
 * The session's keyterms: companies (ticker, name, short aliases), Glance's words, the verbs, then `extra` (basket
 * names), de-duplicated without regard to case, and never more than KEYTERM_MAX. Companies get the room left after
 * KEYTERM_SESSION_ROOM is set aside, so a session's basket names always fit.
 */
export function buildKeyterms(companies: readonly KeytermCompany[], extra: readonly string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string, cap: number) => {
    const c = clean(t);
    if (!usable(c) || seen.has(c.toLowerCase()) || out.length >= cap) return;
    seen.add(c.toLowerCase());
    out.push(c);
  };
  const base = KEYTERM_MAX - KEYTERM_SESSION_ROOM;
  for (const w of [...GLANCE_KEYTERMS, ...COMMAND_KEYTERMS]) add(w, base);
  // Tickers and names first for every company, then their aliases: a long catalog loses aliases before names.
  for (const c of companies) {
    add(c.symbol, base);
    add(c.name, base);
  }
  for (const c of companies) for (const a of c.aliases ?? []) if (a.split(" ").length <= 4) add(a, base);
  for (const e of extra.slice(0, KEYTERM_SESSION_ROOM)) add(e, KEYTERM_MAX);
  return out;
}

/** A session's extra keyterms as the extension sends them: short, plain names only. */
export function sessionKeyterms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === "string")
    .map(clean)
    .filter((t) => t.length > 0 && t.length <= 40 && /^[\p{L}\p{N} .&'-]+$/u.test(t))
    .slice(0, KEYTERM_SESSION_ROOM);
}
