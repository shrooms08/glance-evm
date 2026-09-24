/**
 * "Show me": Glance draws on the page while it talks. The model's spoken reply carries inline action tags, and the
 * extension acts on each one as the speech reaches it. (The pattern of tags inline with speech is adapted from Clicky,
 * github.com/farzaa/clicky, MIT; no code is taken from it.)
 *
 * The grammar is closed. Only these tags exist:
 *   [POINT:"exact quote"]                  the orb flies to that text on the page
 *   [CIRCLE:"exact quote"]                 a hand-drawn circle around it
 *   [UNDERLINE:"exact quote"]              a hand-drawn underline
 *   [BOX:"exact quote"]                    a hand-drawn box around its paragraph, list item, cell or caption
 *   [HIGHLIGHT:"exact quote"]              a marker swipe behind it (the text stays readable)
 *   [ARROW:"from quote"->"to quote"]       a curved arrow between two quotes (skipped if either isn't found)
 *   [BOX_FIGURE:n]                         a box around the nth visible figure the extension listed
 *   [CHART:SYMBOL]                         open that stock's chart
 *   [PORTFOLIO]                            open the portfolio view
 *   [CHART_POINT:SYMBOL:unixtime]          on Glance's own chart: circle the point nearest that time
 *   [CHART_LEVEL:SYMBOL:price:"label"]     a dashed level with a short factual label
 *   [CHART_RANGE:SYMBOL:t1:t2]             a shaded band between two times
 *   [CHART_TREND:SYMBOL:t1:t2]             a straight line between the prices at two times
 * There is no tag that buys, sells or changes a setting, so nothing on a page (whatever it says) can make Glance
 * trade. At most MAX_DRAWINGS drawings a reply. Quotes are at most MAX_QUOTE characters (a longer one is cut at a word boundary). Any other bracketed text is
 * dropped from what's spoken.
 */

export const MAX_QUOTE = 80;
/** Drawings (marks on the page or on a chart) per reply; any beyond it are dropped. */
export const MAX_DRAWINGS = 6;
/** A chart level's label: short and factual ("Week low $362.20"). */
export const MAX_CHART_LABEL = 30;

export const TAG_KINDS = [
  "POINT",
  "CIRCLE",
  "UNDERLINE",
  "BOX",
  "HIGHLIGHT",
  "ARROW",
  "BOX_FIGURE",
  "CHART",
  "PORTFOLIO",
  "CHART_POINT",
  "CHART_LEVEL",
  "CHART_RANGE",
  "CHART_TREND",
] as const;
export type TagKind = (typeof TAG_KINDS)[number];

/** The tags that draw something (capped at MAX_DRAWINGS a reply). POINT, CHART and PORTFOLIO move or open things. */
export const DRAWING_KINDS: ReadonlySet<TagKind> = new Set(["CIRCLE", "UNDERLINE", "BOX", "HIGHLIGHT", "ARROW", "BOX_FIGURE", "CHART_POINT", "CHART_LEVEL", "CHART_RANGE", "CHART_TREND"]);

export type QuoteKind = "POINT" | "CIRCLE" | "UNDERLINE" | "BOX" | "HIGHLIGHT";

export type ShowAction =
  | { kind: QuoteKind; quote: string; at: number }
  | { kind: "ARROW"; from: string; to: string; at: number }
  | { kind: "BOX_FIGURE"; figure: number; at: number }
  | { kind: "CHART"; symbol: string; at: number }
  | { kind: "PORTFOLIO"; at: number }
  | { kind: "CHART_POINT"; symbol: string; t: number; at: number }
  | { kind: "CHART_LEVEL"; symbol: string; price: number; label: string; at: number }
  | { kind: "CHART_RANGE" | "CHART_TREND"; symbol: string; t1: number; t2: number; at: number };

/** A tag, before its place in the speech is known. */
export type Tag = ShowAction extends infer A ? (A extends ShowAction ? Omit<A, "at"> : never) : never;

/** A chart annotation (the chart tags, without their place in the speech). */
export type ChartAnnotation = Extract<ShowAction, { kind: "CHART_POINT" | "CHART_LEVEL" | "CHART_RANGE" | "CHART_TREND" }>;

export interface Tagged {
  /** What's spoken: the reply with every bracket removed and spaces tidied. */
  spoken: string;
  /** The actions, each at its character offset in `spoken` (where the speech reaches it). */
  actions: ShowAction[];
}

/** Anything in square brackets: each is either exactly one allowed tag, or dropped from speech and never acted on. */
const ANY_BRACKET = /\[([^\]\n]{0,500})\]/g;
// A quote may contain anything but a double quote or a newline (straight or curly quotes around it).
const Q = String.raw`["“]([^"”\n]{1,400})["”]`;
const SYM = String.raw`\$?([A-Za-z]{1,6})`;
const TIME = String.raw`(\d{9,11})`;
const SHAPES: Array<[RegExp, (m: RegExpExecArray) => Tag | null]> = [
  [new RegExp(String.raw`^\s*(POINT|CIRCLE|UNDERLINE|BOX|HIGHLIGHT)\s*:\s*${Q}\s*$`, "i"), (m) => quoteAction(m[1]!.toUpperCase() as QuoteKind, m[2]!)],
  [
    new RegExp(String.raw`^\s*ARROW\s*:\s*${Q}\s*(?:->|→|-&gt;)\s*${Q}\s*$`, "i"),
    (m) => {
      const from = capQuote(clean(m[1]!));
      const to = capQuote(clean(m[2]!));
      return from && to ? { kind: "ARROW", from, to } : null;
    },
  ],
  [/^\s*BOX_FIGURE\s*:\s*(\d{1,2})\s*$/i, (m) => (Number(m[1]) >= 1 ? { kind: "BOX_FIGURE", figure: Number(m[1]) } : null)],
  [new RegExp(String.raw`^\s*CHART\s*:\s*${SYM}\s*$`, "i"), (m) => ({ kind: "CHART", symbol: m[1]!.toUpperCase() })],
  [/^\s*PORTFOLIO\s*$/i, () => ({ kind: "PORTFOLIO" })],
  [new RegExp(String.raw`^\s*CHART_POINT\s*:\s*${SYM}\s*:\s*${TIME}\s*$`, "i"), (m) => ({ kind: "CHART_POINT", symbol: m[1]!.toUpperCase(), t: Number(m[2]) })],
  [
    new RegExp(String.raw`^\s*CHART_LEVEL\s*:\s*${SYM}\s*:\s*\$?([\d,]+(?:\.\d+)?)\s*:\s*${Q}\s*$`, "i"),
    (m) => {
      const label = clean(m[3]!);
      const price = Number(m[2]!.replace(/,/g, ""));
      return label.length > 0 && label.length <= MAX_CHART_LABEL && Number.isFinite(price) && price > 0 ? { kind: "CHART_LEVEL", symbol: m[1]!.toUpperCase(), price, label } : null;
    },
  ],
  [
    new RegExp(String.raw`^\s*CHART_(RANGE|TREND)\s*:\s*${SYM}\s*:\s*${TIME}\s*:\s*${TIME}\s*$`, "i"),
    (m) => {
      const t1 = Math.min(Number(m[3]), Number(m[4]));
      const t2 = Math.max(Number(m[3]), Number(m[4]));
      return t2 > t1 ? { kind: `CHART_${m[1]!.toUpperCase()}` as "CHART_RANGE" | "CHART_TREND", symbol: m[2]!.toUpperCase(), t1, t2 } : null;
    },
  ],
];

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function quoteAction(kind: QuoteKind, raw: string): Tag | null {
  const quote = capQuote(clean(raw));
  return quote ? { kind, quote } : null;
}

/** One bracket's content as an allowed tag, or null. */
export function parseTag(inner: string): Tag | null {
  for (const [re, make] of SHAPES) {
    const m = re.exec(inner);
    if (m) return make(m);
  }
  return null;
}

/**
 * Parses a tagged reply. Only the allowed tags become actions (TAG_KINDS); quotes longer than MAX_QUOTE are cut at a
 * word boundary; stock symbols must be in `symbols` when given; drawings beyond MAX_DRAWINGS are dropped; everything
 * else in brackets is stripped.
 */
export function parseTagged(reply: string, opts: { symbols?: ReadonlySet<string> } = {}): Tagged {
  const actions: ShowAction[] = [];
  let spoken = "";
  let last = 0;
  let drawings = 0;
  for (const m of reply.matchAll(ANY_BRACKET)) {
    spoken += reply.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    const tag = parseTag(m[1]!);
    if (!tag) {
      spoken += " "; // not a tag: stripped, never spoken, never acted on
      continue;
    }
    if ("symbol" in tag && opts.symbols && !opts.symbols.has(tag.symbol)) continue;
    if (DRAWING_KINDS.has(tag.kind)) {
      if (drawings >= MAX_DRAWINGS) continue;
      drawings++;
    }
    actions.push({ ...tag, at: tidy(spoken).trimEnd().length } as ShowAction);
  }
  spoken += reply.slice(last);
  const text = tidy(spoken);
  return { spoken: text, actions: actions.map((a) => ({ ...a, at: Math.min(a.at, text.length) })) };
}

/** Keeps the first MAX_DRAWINGS drawings (after pairing marks), and everything that isn't a drawing. */
export function capDrawings(t: Tagged, max = MAX_DRAWINGS): Tagged {
  let n = 0;
  return { spoken: t.spoken, actions: t.actions.filter((a) => !DRAWING_KINDS.has(a.kind) || n++ < max) };
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

/** One action as its tag. */
export function formatTag(a: ShowAction): string {
  switch (a.kind) {
    case "CHART":
      return `[CHART:${a.symbol}]`;
    case "PORTFOLIO":
      return "[PORTFOLIO]";
    case "ARROW":
      return `[ARROW:"${a.from}"->"${a.to}"]`;
    case "BOX_FIGURE":
      return `[BOX_FIGURE:${a.figure}]`;
    case "CHART_POINT":
      return `[CHART_POINT:${a.symbol}:${a.t}]`;
    case "CHART_LEVEL":
      return `[CHART_LEVEL:${a.symbol}:${a.price}:"${a.label}"]`;
    case "CHART_RANGE":
    case "CHART_TREND":
      return `[${a.kind}:${a.symbol}:${a.t1}:${a.t2}]`;
    default:
      return `[${a.kind}:"${a.quote}"]`;
  }
}

/** Re-serializes actions and speech into a tagged reply (for the API's answer and for tests). */
export function formatTagged(t: Tagged): string {
  let out = "";
  let last = 0;
  for (const a of [...t.actions].sort((x, y) => x.at - y.at)) {
    out += t.spoken.slice(last, a.at);
    last = a.at;
    out += formatTag(a);
  }
  return out + t.spoken.slice(last);
}

/**
 * Every POINT gets a visible mark on the same words, unless the reply already marks them: a CIRCLE for a short figure or
 * phrase (up to 40 characters), an UNDERLINE for longer ones. The orb alone is easy to miss; the mark isn't.
 */
export function pairMarks(t: Tagged): Tagged {
  const marked = new Set(t.actions.filter((a) => "quote" in a && a.kind !== "POINT").map((a) => looseText((a as { quote: string }).quote)));
  for (const a of t.actions) if (a.kind === "ARROW") marked.add(looseText(a.from)).add(looseText(a.to));
  const out: ShowAction[] = [];
  for (const a of t.actions) {
    out.push(a);
    if (a.kind === "POINT" && !marked.has(looseText(a.quote))) {
      out.push({ kind: a.quote.length <= 40 ? "CIRCLE" : "UNDERLINE", quote: a.quote, at: a.at });
      marked.add(looseText(a.quote));
    }
  }
  return { spoken: t.spoken, actions: out };
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
    actions: t.actions.filter((a) =>
      "quote" in a ? page.includes(looseText(a.quote)) : a.kind === "ARROW" ? page.includes(looseText(a.from)) && page.includes(looseText(a.to)) : true,
    ),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Drawing on Glance's own charts
// ---------------------------------------------------------------------------------------------------------------------

/** What a chart shows, enough to check the model's chart tags against it. */
export interface ChartShown {
  symbol: string;
  points: ReadonlyArray<{ t: number; price: number }>;
}

/** The time of the real point nearest `t`, or null when `t` is outside the points' span. */
export function snapTime(points: ChartShown["points"], t: number): number | null {
  if (points.length === 0) return null;
  const first = points[0]!.t;
  const last = points.at(-1)!.t;
  if (t < first || t > last) return null;
  let best = points[0]!;
  for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best.t;
}

/**
 * Keeps only chart tags that fit the chart being shown: times snap to the nearest real point and must be inside the
 * range; a level's price must be within the chart's price range (1% slack), and its label short and factual (no
 * forecast words: `isForecast`); a range or trend needs two different points. Tags for a chart that isn't shown, or
 * that doesn't fit, are dropped.
 */
export function validateChartTags(t: Tagged, charts: readonly ChartShown[], isForecast: (label: string) => boolean): Tagged {
  const bySymbol = new Map(charts.map((c) => [c.symbol, c]));
  const out: ShowAction[] = [];
  for (const a of t.actions) {
    if (a.kind !== "CHART_POINT" && a.kind !== "CHART_LEVEL" && a.kind !== "CHART_RANGE" && a.kind !== "CHART_TREND") {
      out.push(a);
      continue;
    }
    const chart = bySymbol.get(a.symbol);
    if (!chart || chart.points.length < 2) continue;
    if (a.kind === "CHART_POINT") {
      const snapped = snapTime(chart.points, a.t);
      if (snapped !== null) out.push({ ...a, t: snapped });
    } else if (a.kind === "CHART_LEVEL") {
      const prices = chart.points.map((p) => p.price);
      const lo = Math.min(...prices);
      const hi = Math.max(...prices);
      if (a.price >= lo * 0.99 && a.price <= hi * 1.01 && !isForecast(a.label)) out.push(a);
    } else {
      const t1 = snapTime(chart.points, a.t1);
      const t2 = snapTime(chart.points, a.t2);
      if (t1 !== null && t2 !== null && t2 > t1) out.push({ ...a, t1, t2 });
    }
  }
  return { spoken: t.spoken, actions: out };
}

/** A chart tag with no chart opened before it in the reply gets its [CHART] first, so the chart is there to draw on. */
export function openChartsFirst(t: Tagged, alreadyOpen: string | null): Tagged {
  const opened = new Set<string>(alreadyOpen ? [alreadyOpen] : []);
  const out: ShowAction[] = [];
  for (const a of [...t.actions].sort((x, y) => x.at - y.at)) {
    if (a.kind === "CHART") opened.add(a.symbol);
    else if ((a.kind === "CHART_POINT" || a.kind === "CHART_LEVEL" || a.kind === "CHART_RANGE" || a.kind === "CHART_TREND") && !opened.has(a.symbol)) {
      out.push({ kind: "CHART", symbol: a.symbol, at: 0 });
      opened.add(a.symbol);
    }
    out.push(a);
  }
  return { spoken: t.spoken, actions: out.sort((x, y) => x.at - y.at) };
}

/** The chart range a question asks about: "today" 1D, "this month" 1M, else a week. */
export function rangeFor(question: string): "1D" | "1W" | "1M" {
  const q = question.toLowerCase();
  if (/\b(today|this morning|this afternoon|intraday|right now|so far today)\b/.test(q)) return "1D";
  if (/\b(month|30 days|four weeks)\b/.test(q)) return "1M";
  return "1W";
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
