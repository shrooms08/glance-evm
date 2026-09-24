/**
 * Parses what the user said (or typed) into a command. Deliberately small and strict: anything it cannot map with
 * confidence is "unknown", and the assistant says so honestly rather than guessing at a trade.
 *
 *   "buy ten dollars of Tesla", "buy $25 of TSLA", "buy twenty five bucks worth of amazon", "buy tesla for $10"
 *   "what's Tesla at", "what is amd trading at", "price of netflix", "how much is palantir"
 *   "how much have I spent today", "how much do I have left today"
 *   any other question ("what's this article saying?", "how do I withdraw?"): "ask", answered by Show me
 */
import { isAsk } from "@glance/core/showme";

export type Command =
  | { kind: "buy"; symbol: string; amount: string }
  | { kind: "price"; symbol: string }
  | { kind: "spent" }
  | { kind: "portfolio" }
  | { kind: "why"; symbol: string }
  | { kind: "chart"; symbol: string }
  /** A question about the page, a term, or how to use Glance: answered by Show me. */
  | { kind: "ask"; question: string }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "unknown"; heard: string };

export interface CompanyAliases {
  symbol: string;
  aliases: string[];
}

const ONES: Record<string, number> = {
  zero: 0, one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };


/** "twenty five" -> 25, "one hundred" -> 100, "a thousand" -> 1000, "2,500" -> 2500, "12.50" -> 12.5. Else null. */
export function parseAmount(text: string): string | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (/^\d+(\.\d{1,2})?$/.test(t)) return String(Number(t)) === "0" ? null : t.replace(/^0+(?=\d)/, "");
  const words = t.replace(/-/g, " ").split(/\s+/).filter((w) => w && w !== "and");
  if (words.length === 0) return null;
  let total = 0;
  let current = 0;
  for (const w of words) {
    if (w in ONES) current += ONES[w]!;
    else if (w in TENS) current += TENS[w]!;
    else if (w === "hundred") current = (current || 1) * 100;
    else if (w === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
    } else return null;
  }
  const n = total + current;
  return n > 0 ? String(n) : null;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9$.,' -]/g, " ")
    .replace(/(?<![0-9])[.,]|[.,](?![0-9])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every way a company might come out of speech recognition: names, tickers, and tickers spelt out ("t s l a"). */
function aliasTable(companies: readonly CompanyAliases[]): Array<{ phrase: string; symbol: string }> {
  const rows: Array<{ phrase: string; symbol: string }> = [];
  for (const c of companies) {
    const phrases = new Set<string>();
    for (const a of [...c.aliases, c.symbol]) {
      const n = normalise(a.replace(/^\$/, ""));
      if (n) phrases.add(n);
    }
    phrases.add(c.symbol.toLowerCase().split("").join(" "));
    for (const p of phrases) rows.push({ phrase: p, symbol: c.symbol });
  }
  return rows.sort((a, b) => b.phrase.length - a.phrase.length);
}

function findCompany(text: string, table: ReturnType<typeof aliasTable>): string | null {
  const t = ` ${normalise(text).replace(/^(the|some|shares of|stock in)\s+/, "").replace(/\s+(stock|shares?|inc)$/, "")} `;
  for (const row of table) if (t.includes(` ${row.phrase} `)) return row.symbol;
  return null;
}

const CURRENCY = "(?:dollars?|bucks|usd|usdg)";

export function parseCommand(input: string, companies: readonly CompanyAliases[]): Command {
  const heard = input.trim();
  const t = normalise(heard).replace(/^(ok |okay |hey |please |glance )+/, "").replace(/ please$/, "");
  const table = aliasTable(companies);

  if (/^(yes|yeah|yep|confirm|do it|go ahead|buy it)$/.test(t)) return { kind: "confirm" };
  if (/^(no|nope|cancel|stop|never mind|nevermind)$/.test(t)) return { kind: "cancel" };

  if (/\b(spent|spend)\b.*\btoday\b|how much .*\b(spent|left)\b|what have i spent|what's left today|how much can i (still )?(spend|buy)/.test(t)) {
    return { kind: "spent" };
  }

  if (/\bhow am i doing\b|\bwhat do i (own|have|hold)\b|\b(show|open|see)( me)? my (portfolio|positions|holdings|stocks)\b|^(my )?(portfolio|positions|holdings)$|\bhow's my portfolio\b/.test(t)) {
    return { kind: "portfolio" };
  }

  // "show me Tesla's chart", "chart AMD", "open the Palantir chart": a company and the word chart (or graph).
  if (/\b(chart|charts|graph)\b/.test(t)) {
    const rest = t
      .replace(/([a-z0-9])'s\b/g, "$1")
      .replace(/\b(show|open|see|pull up|display|bring up)( me)?\b|\b(the|a|price|stock|chart|charts|graph|for|of|on)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const symbol = findCompany(rest, table);
    if (symbol) return { kind: "chart", symbol };
  }

  // "why did Tesla move", "why is AMD down": a company and a movement word.
  if (/\bwhy\b|\bwhat moved\b/.test(t) && /\b(move|moved|moving|up|down|drop|dropped|jump|jumped|fall|fell|rise|rose|rally|rallied|slide|slid|surge|surged|plunge|plunged|spike|spiked|climb|climbed)\b/.test(t)) {
    const symbol = findCompany(t.replace(/^why (did|is|has|was|are)\s+/, "").replace(/\s+(move|moved|moving|up|down|drop|dropped|jump|jumped|fall|fell|rise|rose|rally|rallied|today|so much).*$/, ""), table);
    if (symbol) return { kind: "why", symbol };
  }

  // buy <amount> [dollars] [worth] [of] <company>
  let m = new RegExp(`^(?:buy|get|purchase|grab)\\s+(.+?)\\s*${CURRENCY}?\\s+(?:worth\\s+)?(?:of\\s+)(.+)$`).exec(t);
  if (!m) m = new RegExp(`^(?:buy|get|purchase|grab)\\s+(\\$?[\\d.,]+|[a-z -]+?)\\s+${CURRENCY}\\s+(?:worth\\s+)?(?:of\\s+)?(.+)$`).exec(t);
  if (m) {
    const amount = parseAmount(m[1]!.replace(new RegExp(`\\s*${CURRENCY}$`), ""));
    const symbol = findCompany(m[2]!, table);
    if (amount && symbol) return { kind: "buy", symbol, amount };
  }
  // buy <company> for <amount> [dollars]
  m = new RegExp(`^(?:buy|get|purchase|grab)\\s+(.+?)\\s+for\\s+(.+?)(?:\\s+${CURRENCY})?$`).exec(t);
  if (m) {
    const amount = parseAmount(m[2]!);
    const symbol = findCompany(m[1]!, table);
    if (amount && symbol) return { kind: "buy", symbol, amount };
  }

  m =
    /^(?:what's|whats|what is|how's|how is|where's|where is)\s+(.+?)\s+(?:at|trading at|trading|doing|going for)$/.exec(t) ??
    /^(?:price of|quote for|quote on|how much is|what's the price of|what is the price of)\s+(.+)$/.exec(t) ??
    /^(.+?)\s+(?:price|quote|share price|stock price)$/.exec(t);
  if (m) {
    const symbol = findCompany(m[1]!, table);
    if (symbol) return { kind: "price", symbol };
  }

  // "what's this article saying?", "what's a stock token?", "how do I withdraw?", "should I buy Tesla?", or any other
  // question typed in the panel: Show me answers it, with the page in view.
  if (isAsk(t) || /\?\s*$/.test(heard) || /^(should i|is it|what|why|how|where|which|who|explain|teach|walk|show me)\b/.test(t)) {
    return { kind: "ask", question: heard };
  }

  return { kind: "unknown", heard };
}
