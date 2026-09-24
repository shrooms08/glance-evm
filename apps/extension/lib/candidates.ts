/**
 * Candidate company names on a page, for the one Claude lookup a glance may make (POST /resolve/names): proper nouns
 * the dictionary didn't match. Runs locally over the text the underliner already collected; only the names leave the
 * page, never the text around them.
 *
 * A candidate is a run of 1 to 4 capitalised words (joined by spaces, "&" or "of"), like "Palantir Technologies",
 * "AT&T" or "Bank of America". Skipped: common words and dates, a lone capitalised word that only starts a sentence,
 * anything overlapping a dictionary match, and names already asked about on this page. The most frequent come first,
 * at most MAX_CANDIDATES.
 */
export const MAX_CANDIDATES = 40;

// A capitalised word ("Palantir", "AT&T", "McDonald's", "Amazon.com", "3M"); a dot only inside, never at the end.
const WORD = String.raw`(?:\p{Lu}[\p{L}\p{N}'’&\-]*(?:\.[\p{L}\p{N}]+)*|\d+\p{Lu}[\p{L}\p{N}]*)`;
const RUN = new RegExp(String.raw`${WORD}(?:(?: | & | of )${WORD}){0,3}`, "gu");

/** Capitalised words that are never a company on their own. */
const STOP = new Set(
  (
    "A An And Are As At Be But By For From He Her His How I If In Is It Its Me My No Not Of On Or Our She So That The Their " +
    "Them Then There These They This Those To Up Us Was We What When Where Which Who Why Will With You Your Yes New More " +
    "Most Mr Mrs Ms Dr Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July " +
    "August September October November December Today Yesterday Tomorrow Read Share Follow Subscribe Sign Log Menu Home " +
    "News Search Photo Video Advertisement Contact About Privacy Terms Cookie Cookies Getty Images Reuters AP Bloomberg " +
    "CEO CFO CTO US USA UK EU AI GDP IPO ETF SEC FTC DOJ NYSE Nasdaq Inc Corp Co Ltd LLC"
  ).split(" "),
);

/** Words that often start a sentence: dropped from the front of a run that starts one ("Also Initech" is "Initech"). */
const STARTERS = new Set(
  (
    "Also After Again Although Analysts Before Both Despite During Each Even Every Here However Investors Last Later " +
    "Meanwhile Next Now Once Only Over Shares Since Some Still Such Than Though Through Under Until While Yet Earlier " +
    "Overall Instead Indeed Plus Just Many Much Other Others Several"
  ).split(" "),
);

const trimRun = (s: string) => s.replace(/^(?:The|A|An) /u, "").replace(/[.’'\-]+$/u, "").replace(/['’]s$/u, "");

/** True when `offset` in `text` starts a sentence (or a block): only whitespace since . ! ? or a newline. */
function startsSentence(text: string, offset: number): boolean {
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === "\n") return true;
    if (ch === " " || ch === "\t" || ch === "“" || ch === '"' || ch === "(") continue;
    return ch === "." || ch === "!" || ch === "?" || ch === ":";
  }
  return true;
}

/**
 * Company-like names in `text`, outside `matched` spans (the dictionary's [start, end) matches) and not in `skip`
 * (lowercased names already asked), most frequent first, at most `max`.
 */
export function companyCandidates(text: string, matched: ReadonlyArray<{ start: number; end: number }> = [], skip: ReadonlySet<string> = new Set(), max = MAX_CANDIDATES): string[] {
  const counts = new Map<string, { name: string; count: number; first: number }>();
  const overlaps = (s: number, e: number) => matched.some((m) => s < m.end && e > m.start);
  for (const m of text.matchAll(RUN)) {
    const start = m.index ?? 0;
    const raw = m[0];
    if (overlaps(start, start + raw.length)) continue;
    let name = trimRun(raw).trim();
    let at = start + raw.indexOf(name);
    // Drop sentence-starting filler from the front: "Also Initech" is "Initech", "The EV maker" is handled by trimRun.
    while (startsSentence(text, at) || STOP.has(name.split(" ")[0]!)) {
      const [first, ...rest] = name.split(" ");
      if (rest.length === 0 || !(STARTERS.has(first!) || STOP.has(first!))) break;
      name = rest.join(" ").replace(/^(?:& |of )/u, "");
      at = text.indexOf(name, at);
    }
    if (name.length < 2 || name.length > 60) continue;
    const words = name.split(/ (?:& |of )?/u);
    if (words.every((w) => STOP.has(w))) continue;
    // A lone word at the start of a sentence is usually just a capitalised word ("Shares rose..."): skip it unless
    // it also appears mid-sentence, where capitals mean a name (counted below when it does).
    if (words.length === 1 && startsSentence(text, at) && !/^\p{Lu}{2,}$/u.test(name)) continue;
    if (words.length === 1 && name.length < 3) continue;
    const key = name.toLowerCase();
    if (skip.has(key)) continue;
    const seen = counts.get(key);
    if (seen) seen.count++;
    else counts.set(key, { name, count: 1, first: at });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, max)
    .map((c) => c.name);
}

/** Every whole-word occurrence of `name` in `text`, as [start, end) offsets. */
export function occurrences(text: string, name: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + name.length)) {
    if (isWord(text[i - 1]) || isWord(text[i + name.length])) continue;
    out.push({ start: i, end: i + name.length });
  }
  return out;
}
