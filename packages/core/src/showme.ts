/**
 * "Show me": Glance draws on the page while it talks. The model's spoken reply carries inline action tags, and the
 * extension acts on each one as the speech reaches it. (The pattern of tags inline with speech is adapted from Clicky,
 * github.com/farzaa/clicky, MIT; no code is taken from it.)
 *
 * The grammar is closed. Only five tags exist:
 *   [POINT:"exact quote"]      the orb flies to that text on the page
 *   [CIRCLE:"exact quote"]     a hand-drawn circle around it
 *   [UNDERLINE:"exact quote"]  a hand-drawn underline
 *   [CHART:SYMBOL]             open that stock's chart
 *   [PORTFOLIO]                open the portfolio view
 * There is no tag that buys, sells or changes a setting, so nothing on a page (whatever it says) can make Glance
 * trade. Quotes are at most MAX_QUOTE characters (a longer one is cut at a word boundary). Any other bracketed text is
 * dropped from what's spoken.
 */

export const MAX_QUOTE = 80;
export const TAG_KINDS = ["POINT", "CIRCLE", "UNDERLINE", "CHART", "PORTFOLIO"] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export type ShowAction =
  | { kind: "POINT" | "CIRCLE" | "UNDERLINE"; quote: string; at: number }
  | { kind: "CHART"; symbol: string; at: number }
  | { kind: "PORTFOLIO"; at: number };

export interface Tagged {
  /** What's spoken: the reply with every bracket removed and spaces tidied. */
  spoken: string;
  /** The actions, each at its character offset in `spoken` (where the speech reaches it). */
  actions: ShowAction[];
}

// A quote may contain anything but a double quote or a newline (straight or curly quotes around it).
const QUOTED = String.raw`["“]([^"”\n]{1,400})["”]`;
const TAG = new RegExp(String.raw`\[\s*(POINT|CIRCLE|UNDERLINE)\s*:\s*${QUOTED}\s*\]|\[\s*CHART\s*:\s*\$?([A-Za-z]{1,6})\s*\]|\[\s*PORTFOLIO\s*\]`, "gi");
/** Anything else in square brackets (unknown tags, stray markup): dropped from speech, never acted on. */
const ANY_BRACKET = /\[[^\]\n]{0,500}\]/g;

/**
 * Parses a tagged reply. Only the five allowed tags become actions; quotes longer than MAX_QUOTE are cut at a word
 * boundary; CHART symbols must be in `symbols` when given; everything else in brackets is stripped.
 */
export function parseTagged(reply: string, opts: { symbols?: ReadonlySet<string> } = {}): Tagged {
  const actions: ShowAction[] = [];
  let spoken = "";
  let last = 0;
  const clean = (s: string) => s.replace(ANY_BRACKET, " ");
  for (const m of reply.matchAll(TAG)) {
    spoken += clean(reply.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const at = tidy(spoken).trimEnd().length;
    const kind = (m[1] ?? (m[3] ? "CHART" : "PORTFOLIO")).toUpperCase() as TagKind;
    if (kind === "CHART") {
      const symbol = m[3]!.toUpperCase();
      if (!opts.symbols || opts.symbols.has(symbol)) actions.push({ kind, symbol, at });
    } else if (kind === "PORTFOLIO") {
      actions.push({ kind, at });
    } else {
      const quote = capQuote(m[2]!.replace(/\s+/g, " ").trim());
      if (quote.length > 0) actions.push({ kind: kind as "POINT" | "CIRCLE" | "UNDERLINE", quote, at });
    }
  }
  spoken += clean(reply.slice(last));
  const text = tidy(spoken);
  return { spoken: text, actions: actions.map((a) => ({ ...a, at: Math.min(a.at, text.length) })) };
}

/**
 * A quote over MAX_QUOTE characters is cut at a word boundary (still a verbatim piece of the page): its start is
 * enough to find it. Returns "" when nothing sensible is left.
 */
export function capQuote(quote: string): string {
  if (quote.length <= MAX_QUOTE) return quote;
  const cut = quote.slice(0, MAX_QUOTE);
  const space = cut.lastIndexOf(" ");
  const out = (space >= 12 ? cut.slice(0, space) : cut).replace(/[\s,;:.(—–-]+$/, "");
  return out.length >= 3 ? out : "";
}

/** Collapses spaces, and the space a removed tag leaves before punctuation. */
function tidy(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trimStart();
}

/** Re-serializes actions and speech into a tagged reply (for the API's answer and for tests). */
export function formatTagged(t: Tagged): string {
  let out = "";
  let last = 0;
  for (const a of [...t.actions].sort((x, y) => x.at - y.at)) {
    out += t.spoken.slice(last, a.at);
    last = a.at;
    out += a.kind === "CHART" ? `[CHART:${a.symbol}]` : a.kind === "PORTFOLIO" ? "[PORTFOLIO]" : `[${a.kind}:"${a.quote}"]`;
  }
  return out + t.spoken.slice(last);
}

/** Whitespace- and case-tolerant form used to match quotes against page text. */
export function looseText(s: string): string {
  return s.normalize("NFKC").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—‒]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Keeps only the quote actions whose quote appears in `pageText` (loosely): the model can't point at invented text. */
export function keepQuotesOnPage(t: Tagged, pageText: string): Tagged {
  const page = looseText(pageText);
  return {
    spoken: t.spoken,
    actions: t.actions.filter((a) => !("quote" in a) || page.includes(looseText(a.quote))),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Which requests are Show me / teach / guide
// ---------------------------------------------------------------------------------------------------------------------

/** A question about the page, a concept, or how to use Glance (lowercased, normalised text). */
export function isAsk(text: string): boolean {
  const t = text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
  return (
    /\b(this|the|that) (article|page|story|post|piece|chart|graph|image|picture|table|paragraph|section|headline|report)\b/.test(t) ||
    /\bshow me (where|what|how|which)\b|\bwhere (does|did|is) (it|this|the \w+) (say|mention|talk)/.test(t) ||
    /\b(point|circle|underline|highlight) (to |at |out )?(it|that|where|the)\b/.test(t) ||
    /^(what's|whats|what is|what are|what does|what do) (a|an|the)? ?(stock token|stock tokens|p ?\/? ?e|pe ratio|weekend guard|guard|guards|slippage|usdg|vault|agent|oracle|market cap|dividend|etf|testnet|stand ?in|daily cap|per trade cap|limit|limits)\b/.test(t) ||
    /^(what's|whats|what is|what are) (a|an) \w+/.test(t) ||
    /\bwhat does (the )?[a-z ]{2,30} (do|mean)\b/.test(t) ||
    /^how (do|can|would) i\b|\bwalk me through\b|\bteach me\b|\bhow does (glance|the vault|the agent|this) work\b/.test(t) ||
    /^explain (this|the|what|how|that|it)\b|\bsumm(ar(y|ise|ize)) (this|the|it)\b|\bwhat('s| is) (this|it) (saying|about)\b/.test(t)
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Timing: when each action fires during playback
// ---------------------------------------------------------------------------------------------------------------------

/** Sienna speaks about this many characters a second (measured on Glance replies); used until the audio's length is known. */
export const CHARS_PER_SECOND = 14;

/** Where the first sentence ends: actions before it fire at once, as the voice starts. */
export function firstSentenceEnd(spoken: string): number {
  const m = /[.!?](\s|$)/.exec(spoken);
  return m ? m.index + 1 : spoken.length;
}

/**
 * The playback time (seconds) at which an action at character `at` should fire: its share of the text times the
 * audio's duration (estimated from the text's length until the player knows it). Actions inside the first sentence
 * fire at 0.
 */
export function fireTime(at: number, spoken: string, duration: number | null): number {
  if (at <= firstSentenceEnd(spoken)) return 0;
  const total = duration && Number.isFinite(duration) && duration > 0 ? duration : spoken.length / CHARS_PER_SECOND;
  return (at / Math.max(1, spoken.length)) * total;
}
