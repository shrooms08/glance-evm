/**
 * How Glance talks, next to the guard sentences (errors.ts): every new user-facing string follows these rules, and the
 * news summaries are checked against them after generation.
 *
 *   Plain, friendly, short.
 *   Explains, never advises: no "you should", no predictions, no price targets.
 *   Every claim about news cites a source.
 */
export const TONE_RULES = [
  "Plain, friendly and short.",
  "Explain what happened; never advise. No \"you should\", no suggestion to buy or sell.",
  "No predictions and no price targets.",
  "Every claim about news cites its source by number, like [1].",
] as const;

/**
 * Phrases that turn an explanation into advice or a prediction. A generated summary containing any of these is thrown
 * away and only the headlines are shown.
 */
export const ADVICE_PATTERNS: readonly RegExp[] = [
  /\byou should\b/i,
  /\byou (might|may) want to\b/i,
  /\bconsider (buying|selling|adding|trimming)\b/i,
  /\b(buy|sell) now\b/i,
  /\brecommend(s|ed|ation|ations)?\b/i,
  /\bprice target(s)?\b/i,
  /\bwill (rise|fall|climb|drop|go up|go down|rally|recover|rebound)\b/i,
  /\bexpected to (reach|hit|rise|fall|climb|drop)\b/i,
  /\bgood time to (buy|sell)\b/i,
  /\b(undervalued|overvalued)\b/i,
];

export function containsAdvice(text: string): boolean {
  return ADVICE_PATTERNS.some((p) => p.test(text));
}

/**
 * On a chart, these words read as a forecast ("support at $360", "a breakout", "the level will hold"): a chart reply
 * or label describes what happened, never what will. A label with one is dropped; a reply with one is replaced.
 */
export const CHART_ADVICE_PATTERNS: readonly RegExp[] = [
  /\bsupports?\b/i,
  /\bresistance\b/i,
  /\bbreak ?outs?\b/i,
  /\bbreak(s|ing)? (out|through)\b/i,
  /\btargets?\b/i,
  /\bwill (hold|bounce|break|test|retest)\b/i,
  // A chart describes what happened: no "will" at all ("it will keep sliding", "that level will matter").
  /\bwill\b/i,
  /\bpredict(s|ed|ion|ions)?\b|\bforecast(s|ed)?\b/i,
  /\bbottomed\b|\bbottoming\b/i,
  /\boversold\b|\boverbought\b/i,
];

export function containsChartAdvice(text: string): boolean {
  return containsAdvice(text) || CHART_ADVICE_PATTERNS.some((p) => p.test(text));
}

export const NO_CLEAR_NEWS = "No clear news explains this move.";
export const NEWS_UNAVAILABLE = "News isn't available right now.";
export const NO_RECENT_NEWS = "No news about this company in the last 3 days.";
export const EMPTY_PORTFOLIO = "No stocks yet. Everything's in USDG.";
export const BOUGHT_OUTSIDE_PAGE = "Bought outside a page";
export const AS_OF_LAST_CLOSE = "The market is closed, so this is the move as of the last close.";

/** "up $1.40", "down $0.20", "even" from a signed raw USDG amount. */
export function upDown(raw: bigint, formatAbs: (abs: bigint) => string): string {
  if (raw > 0n) return `up ${formatAbs(raw)}`;
  if (raw < 0n) return `down ${formatAbs(-raw)}`;
  return "even";
}
