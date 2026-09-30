/**
 * "What did I buy last?", "What did I sell last?", "Show my last 3 trades": answered from the linked vault's activity
 * (the same events as the console's Activity page), read only. The question is recognised here for both the spoken
 * and the typed path; a command that starts with a trade verb ("buy the last one", "sell what I bought last") is never
 * one of these: it stays a trade, with its confirm card.
 */

export interface LastTradesAsk {
  side: "buy" | "sell" | "any";
  /** How many to list (1 to 5). */
  count: number;
}

/** One vault event, as GET /vault/:address/activity lists it (newest first). */
export interface ActivityLike {
  type: string;
  kind: string;
  summary: string;
  timestamp: number;
}

export const MAX_TRADES_LISTED = 5;

export const NO_VAULT_TRADES = "There's no vault linked in this browser yet, so I can't see your trades. Set one up from the console's Get started page.";

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const LEADING_TRADE_VERB = /^(?:(?:ok|okay|hey|glance|please|can you|could you|now)\s+)*(buy|buying|sell|selling|purchase|get me|grab|dump)\b/;

/** The question, if it asks about past trades; null otherwise (and always null for a command to trade). */
export function lastTradesAsk(text: string): LastTradesAsk | null {
  const t = text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[?.!,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (LEADING_TRADE_VERB.test(t)) return null;
  const n = /\blast (\d|one|two|three|four|five) (?:trades?|buys?|sells?|sales?|purchases?|orders?)\b/.exec(t)?.[1];
  const count = Math.min(MAX_TRADES_LISTED, Math.max(1, n ? (WORD_NUMBERS[n] ?? Number(n)) : 1));
  if (/\bwhat (?:did|have) i (?:just )?(?:buy|bought|purchase|purchased)\b.*\b(last|recently|most recently)\b|\bwhat was my (?:last|latest|most recent) (?:buy|purchase)\b|\bmy (?:last|latest|most recent) (?:buy|purchase)\b/.test(t)) {
    return { side: "buy", count };
  }
  if (/\bwhat (?:did|have) i (?:just )?(?:sell|sold)\b.*\b(last|recently|most recently)\b|\bwhat was my (?:last|latest|most recent) (?:sell|sale)\b|\bmy (?:last|latest|most recent) (?:sell|sale)\b/.test(t)) {
    return { side: "sell", count };
  }
  if (/\b(?:my|the) (?:last|latest|most recent|recent) (?:\d |one |two |three |four |five )?(?:trades?|orders?)\b|\bwhat did i (?:last )?trade\b|\bwhat have i traded\b|\btrade history\b/.test(t)) {
    return { side: "any", count: n ? count : /\btrades\b|\bhistory\b|\borders\b/.test(t) ? 3 : 1 };
  }
  return null;
}

const day = (t: number) => new Date(t * 1000).toLocaleString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" });
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The spoken answer, from the vault's events (newest first), with every number taken from them. */
export function lastTradesReply(items: readonly ActivityLike[], ask: LastTradesAsk): string {
  const trades = [...items]
    .filter((i) => i.kind === "trade" && (ask.side === "any" || (ask.side === "buy" ? i.type === "Bought" : i.type === "Sold")))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, ask.count);
  const noun = ask.side === "buy" ? "buys" : ask.side === "sell" ? "sells" : "trades";
  // The activity covers a recent window (the console's Activity page shows the same).
  if (trades.length === 0) return `I don't see any ${noun} in your vault's recent activity.`;
  if (trades.length === 1 && ask.count === 1) {
    const [only] = trades;
    const line = `${only!.summary} on ${day(only!.timestamp)}`;
    return ask.side === "any" ? `Your last trade: ${lowerFirst(line)}.` : `You last ${lowerFirst(line)}.`;
  }
  const listed = trades.map((t) => `${lowerFirst(t.summary)} on ${day(t.timestamp)}`).join("; ");
  const label = trades.length === 1 ? noun.replace(/s$/, "") : `${trades.length} ${noun}`;
  return `Your last ${label}: ${listed}.`;
}
