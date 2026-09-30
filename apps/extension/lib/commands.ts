/**
 * Parses what the user said (or typed) into a command. Deliberately small and strict: anything it cannot map with
 * confidence is "unknown", and the assistant says so honestly rather than guessing at a trade.
 *
 *   "buy ten dollars of Tesla", "buy $25 of TSLA", "buy twenty five bucks worth of amazon", "buy tesla for $10"
 *   "sell ten dollars of Tesla", "sell all my Palantir", "sell half my Tesla", "sell my Tesla" (the card asks how much)
 *   "sell my tech basket": baskets aren't sold as one (the reply says to name the stock)
 *   "what's Tesla at", "what is amd trading at", "price of netflix", "how much is palantir"
 *   "how much have I spent today", "how much do I have left today"
 *   "buy $30 of the tech basket", "buy the EV basket for $20"
 *   "make a basket called EV with Tesla and AMD, 50/50", "show my baskets"
 *   "compare Tesla and AMD this week", "Tesla vs AMD today" (2 or 3 stocks)
 *   "how did Tesla do this week?", "what was the biggest drop?": "ask", answered by Show me with the chart's facts
 *   any other question ("what's this article saying?", "how do I withdraw?"): "ask", answered by Show me
 */
import { parseSplit } from "@glance/core/basket";
import type { ChartRange } from "@glance/core/chart";
import { MAX_COMPARE } from "@glance/core/chart-facts";
import { isAsk, isChartQuestion, rangeFor } from "@glance/core/showme";
import { lastTradesAsk, type LastTradesAsk } from "@glance/core/trades";

export type Command =
  | { kind: "buy"; symbol: string; amount: string }
  /** Dollars' worth (`amount`), part of the holding (`fraction`: "1" all, "0.5" half), or neither (the card asks). */
  | { kind: "sell"; symbol: string; amount?: string; fraction?: "1" | "0.5" }
  /** A basket named in a sell: not sold as one. */
  | { kind: "sellBasket"; basket: string }
  /** A buy or sell of a stock outside the catalog (the page's NVIDIA, or a ticker typed in capitals): refused plainly. */
  | { kind: "notTradable"; symbol: string; name: string }
  | { kind: "price"; symbol: string }
  | { kind: "spent" }
  | { kind: "portfolio" }
  | { kind: "why"; symbol: string }
  | { kind: "chart"; symbol: string }
  /** A basket, by name as said ("tech"); the caller finds it among this browser's baskets. */
  | { kind: "buyBasket"; basket: string; amount: string }
  /** Weights in basis points, or null for equal weights. `unmatched`: names that aren't in the catalog. */
  | { kind: "makeBasket"; name: string; symbols: string[]; weights: number[] | null; unmatched: string[] }
  | { kind: "baskets" }
  | { kind: "compare"; symbols: string[]; range: ChartRange }
  /** "What did I buy last?", "Show my last 3 trades": the vault's own activity, read only. */
  | { kind: "lastTrades"; ask: LastTradesAsk }
  /** Developer check: draw every Show me shape on the current selection. */
  | { kind: "testDrawing" }
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

/** Every company named in the text, in the order said (longest names first, so "amazon web services" isn't "amazon"). */
function companiesIn(text: string, table: ReturnType<typeof aliasTable>): string[] {
  let rest = ` ${normalise(text).replace(/\b(the|some|shares of|stock in)\b/g, " ").replace(/\s+/g, " ").trim()} `;
  const hits: Array<{ at: number; symbol: string }> = [];
  for (const row of table) {
    const at = rest.indexOf(` ${row.phrase} `);
    if (at < 0) continue;
    hits.push({ at, symbol: row.symbol });
    rest = `${rest.slice(0, at + 1)}${"#".repeat(row.phrase.length)}${rest.slice(at + 1 + row.phrase.length)}`;
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.symbol);
}

const CURRENCY = "(?:dollars?|bucks|usd|usdg)";

/** "Tesla and AMD, 50/50" -> the companies and the split ("50/50", "60 40", "60% 40%"), if one was given. */
function basketLegs(text: string, table: ReturnType<typeof aliasTable>): { symbols: string[]; weights: number[] | null; unmatched: string[] } {
  const split = /(?:[, ]+(?:split |weighted )?)((?:\d+(?:\.\d+)?%?\s*(?:\/|,|\s|and)\s*)+\d+(?:\.\d+)?%?)\s*(?:split)?$/.exec(text);
  const names = (split ? text.slice(0, split.index) : text)
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/)
    .map((n) => n.trim())
    .filter(Boolean);
  const symbols: string[] = [];
  const unmatched: string[] = [];
  for (const n of names) {
    // A chunk may name several ("netflix amazon": the commas are gone by now), in the order said.
    const found = companiesIn(n, table);
    if (found.length === 0) unmatched.push(n);
    for (const symbol of found) if (!symbols.includes(symbol)) symbols.push(symbol);
  }
  return { symbols, weights: split ? parseSplit(split[1]!, symbols.length) : null, unmatched };
}

/**
 * A buy or sell that names no catalog stock but means one outside it: the page's own stock (by name, ticker, or "it" /
 * "this"), or a ticker typed in capitals ("buy $10 of NVDA"). Null otherwise.
 */
function offCatalogTrade(heard: string, t: string, companies: readonly CompanyAliases[], page: { symbol: string; name: string } | null): { symbol: string; name: string } | null {
  if (!/^(?:buy|get|purchase|grab|sell|dump|unload|get rid of)\b/.test(t)) return null;
  const known = new Set(companies.map((c) => c.symbol));
  const words = ` ${t} `;
  if (page && !known.has(page.symbol)) {
    const name = normalise(page.name);
    if ((name.length >= 2 && words.includes(` ${name} `)) || words.includes(` ${page.symbol.toLowerCase()} `) || / (it|this|this one|this stock|that) /.test(words)) return page;
  }
  const typed = [...heard.matchAll(/\b([A-Z]{2,5})\b/g)].map((m) => m[1]!).find((x) => !known.has(x) && !["USD", "USDG", "ETF"].includes(x));
  return typed ? { symbol: typed, name: page?.symbol === typed ? page.name : typed } : null;
}

export function parseCommand(input: string, companies: readonly CompanyAliases[], baskets: readonly string[] = [], page: { symbol: string; name: string } | null = null): Command {
  const heard = input.trim();
  const t = normalise(heard).replace(/^(ok |okay |hey |please |glance )+/, "").replace(/ please$/, "");
  const table = aliasTable(companies);

  if (/^(glance )?test drawings?$/.test(t) || normalise(heard) === "glance test drawing") return { kind: "testDrawing" };
  if (/^(yes|yeah|yep|confirm|do it|go ahead|buy it|sell it)$/.test(t)) return { kind: "confirm" };
  if (/^(no|nope|cancel|stop|never mind|nevermind)$/.test(t)) return { kind: "cancel" };

  // Baskets, before the single-stock buy: "buy $30 of the tech basket", "buy the EV basket for $20", "make a basket
  // called EV with Tesla and AMD, 50/50", "show my baskets".
  if (/^(?:(?:show|list|see|open)(?: me)? )?(?:my |the )?baskets$|^what baskets\b/.test(t)) return { kind: "baskets" };
  const sb = /^(?:sell|dump|unload)\s+(?:(?:all|half)\s+(?:of\s+)?)?(?:the\s+|my\s+)?(.+?)\s+basket$/.exec(t) ?? /^(?:sell|dump|unload)\s+(?:the\s+|my\s+)?basket\s+(.+)$/.exec(t);
  if (sb) return { kind: "sellBasket", basket: sb[1]! };
  let b = /^(?:make|create|build|start)(?: me)? (?:a |an )?(?:new )?basket (?:called|named) (.+?) (?:with|of|from) (.+)$/.exec(t);
  if (b) return { kind: "makeBasket", name: titleCase(heardName(heard, b[1]!)), ...basketLegs(b[2]!, table) };
  b =
    new RegExp(`^(?:buy|get|purchase|grab)\\s+(.+?)\\s*${CURRENCY}?\\s+(?:worth\\s+)?of\\s+(?:the\\s+|my\\s+)?(.+?)\\s+basket$`).exec(t) ??
    new RegExp(`^(?:buy|get|purchase|grab)\\s+(.+?)\\s*${CURRENCY}?\\s+(?:worth\\s+)?of\\s+(?:the\\s+|my\\s+)?basket\\s+(.+)$`).exec(t);
  if (b) {
    const amount = parseAmount(b[1]!.replace(new RegExp(`\\s*${CURRENCY}$`), ""));
    if (amount) return { kind: "buyBasket", basket: b[2]!, amount };
  }
  b = new RegExp(`^(?:buy|get|purchase|grab)\\s+(?:the\\s+|my\\s+)?(.+?)\\s+basket\\s+for\\s+(.+?)(?:\\s+${CURRENCY})?$`).exec(t);
  if (b) {
    const amount = parseAmount(b[2]!);
    if (amount) return { kind: "buyBasket", basket: b[1]!, amount };
  }
  // "buy $30 of tech": a basket's own name, when it isn't also a company.
  const named = new RegExp(`^(?:buy|get|purchase|grab)\\s+(.+?)\\s*${CURRENCY}?\\s+(?:worth\\s+)?of\\s+(?:the\\s+|my\\s+)?(.+)$`).exec(t);
  if (named && baskets.some((n) => normalise(n) === named[2]) && !findCompany(named[2]!, table)) {
    const amount = parseAmount(named[1]!.replace(new RegExp(`\\s*${CURRENCY}$`), ""));
    if (amount) return { kind: "buyBasket", basket: named[2]!, amount };
  }

  // "What did I buy last?", "show my last 3 trades": never a command that starts with a trade verb ("buy the last
  // one", "sell what I bought last" stay trades, with their confirm cards).
  const trades = lastTradesAsk(heard);
  if (trades) return { kind: "lastTrades", ask: trades };

  // "compare Tesla and AMD this week", "Tesla vs AMD": 2 or 3 stocks, side by side.
  if (/^compare\b|\b(vs|versus)\b/.test(t)) {
    const symbols = companiesIn(t.replace(/^compare\s+/, ""), table);
    if (symbols.length >= 2 && symbols.length <= MAX_COMPARE) return { kind: "compare", symbols, range: rangeFor(t) };
  }
  // "how did Tesla do this week?", "how am I doing on AMD since I bought?": the chart's facts, before "how am I doing".
  if (isChartQuestion(t)) return { kind: "ask", question: heard };

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

  const sell = parseSell(t, table);
  if (sell) return sell;
  // A trade of a stock the vault doesn't hold on its list: explaining works, trading doesn't.
  const off = offCatalogTrade(heard, t, companies, page);
  if (off) return { kind: "notTradable", ...off };

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

/**
 * "sell $10 of tesla", "sell ten dollars worth of tesla", "sell tesla for $10", "sell all my palantir", "sell all of my
 * palantir", "sell half my tesla", "sell my tesla". Null when no catalog company is named.
 */
function parseSell(t: string, table: ReturnType<typeof aliasTable>): Command | null {
  const verb = /^(?:sell|dump|unload|get rid of)\s+(.+)$/.exec(t);
  if (!verb) return null;
  const rest = verb[1]!;
  // All or half of the holding.
  const part = /^(all|everything|half)(?:\s+of)?(?:\s+(?:my|the|your))?\s+(.+?)(?:\s+(?:shares?|stock|position))?$/.exec(rest);
  if (part) {
    const symbol = findCompany(part[2]!, table);
    if (symbol) return { kind: "sell", symbol, fraction: part[1] === "half" ? "0.5" : "1" };
  }
  // A dollar amount: "<amount> [dollars] [worth] of <company>", "<company> for <amount>".
  const worth = new RegExp(`^(.+?)\\s*${CURRENCY}?\\s+(?:worth\\s+)?of\\s+(?:my\\s+)?(.+)$`).exec(rest);
  if (worth) {
    const amount = parseAmount(worth[1]!.replace(new RegExp(`\\s*${CURRENCY}$`), ""));
    const symbol = findCompany(worth[2]!, table);
    if (amount && symbol) return { kind: "sell", symbol, amount };
  }
  const forAmount = new RegExp(`^(?:my\\s+)?(.+?)\\s+for\\s+(.+?)(?:\\s+${CURRENCY})?$`).exec(rest);
  if (forAmount) {
    const amount = parseAmount(forAmount[2]!);
    const symbol = findCompany(forAmount[1]!, table);
    if (amount && symbol) return { kind: "sell", symbol, amount };
  }
  // No amount: the card asks.
  const symbol = findCompany(rest.replace(/^(?:my|the|some)\s+/, ""), table);
  return symbol ? { kind: "sell", symbol } : null;
}

/** The basket's name as the user wrote it (their capitals), found back in the original text. */
function heardName(heard: string, lowered: string): string {
  const at = heard.toLowerCase().indexOf(lowered);
  return at >= 0 ? heard.slice(at, at + lowered.length) : lowered;
}

/** "ev" -> "EV" (short names read as initials), "clean energy" -> "Clean Energy"; names typed with capitals are kept. */
function titleCase(name: string): string {
  if (/[A-Z]/.test(name)) return name.trim();
  const n = name.trim();
  if (n.length <= 3 && !n.includes(" ")) return n.toUpperCase();
  return n.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** The catalog companies a question names, in order (the chart lens uses it to find the stock the user means). */
export function companiesInText(text: string, companies: readonly CompanyAliases[]): string[] {
  return companiesIn(text, aliasTable(companies));
}
