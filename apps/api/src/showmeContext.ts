/**
 * The part of a page Show me sends to Claude: the paragraphs that bear on the question, about 2,500 tokens, instead
 * of the whole 6,000-token extract (a smaller prompt is a faster first word). The opening is always kept (it says what
 * the page is), then the best-scoring paragraphs, in page order, with "…" where text was left out. A question with
 * nothing to match on ("what's this about?") gets the whole extract, as before. Page text is never stored or logged.
 */

/** About 2,500 tokens of page. */
export const RELEVANT_MAX_CHARS = 10_000;
/** The page's opening, always kept. */
const LEAD_CHARS = 900;

const STOP = new Set(
  (
    "the a an and or of to in on at for from by with about into over this that these those it its is are was were be been " +
    "what whats what's where which who whom why how when show me tell explain point circle find mark highlight say says " +
    "saying said page article story post text here there does do did can could would should will just please glance you your " +
    "my i we our they their them key main most some any all more"
  ).split(" "),
);

/** Questions about figures: paragraphs with numbers in them count. */
const NUMBERS = /\b(numbers?|figures?|stats?|statistics|data|how (much|many)|percent(age)?|revenue|sales|profit|earnings|price|margin|growth|deliveries)\b/i;

function words(text: string): string[] {
  return text.toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9][a-z0-9'.-]*[a-z0-9]|[a-z0-9]/g) ?? [];
}

/** The question's content words (and a crude stem of each, so "dropped" meets "drop"). */
function keywords(question: string): string[] {
  const out = new Set<string>();
  for (const w of words(question)) {
    if (STOP.has(w) || w.length < 3) continue;
    out.add(w.replace(/'s$/, ""));
    out.add(w.replace(/(ing|ed|es|s)$/, ""));
  }
  return [...out].filter((w) => w.length >= 3);
}

function score(paragraph: string, keys: readonly string[], wantsNumbers: boolean): number {
  const lower = paragraph.toLowerCase();
  let s = 0;
  for (const k of keys) if (lower.includes(k)) s += 2;
  if (wantsNumbers) s += Math.min(4, (paragraph.match(/\d[\d,.]*\s*(%|percent|billion|million|thousand|bn|m\b)|\$\s?\d/gi) ?? []).length);
  return s;
}

/**
 * The page text for this question: all of it when it's short already, or when nothing in the question picks
 * paragraphs out; else the opening plus the most relevant paragraphs, at most `max` characters, in page order.
 */
export function relevantText(text: string, question: string, max = RELEVANT_MAX_CHARS, fallbackMax = 24_000): { text: string; selected: boolean } {
  if (text.length <= max) return { text, selected: false };
  const keys = keywords(question);
  const wantsNumbers = NUMBERS.test(question);
  const paras = text.split("\n");
  const scores = paras.map((p) => score(p, keys, wantsNumbers));
  if (!scores.some((s) => s > 0)) return { text: text.slice(0, fallbackMax), selected: false };

  const keep = new Set<number>();
  let used = 0;
  // The opening.
  for (let i = 0; i < paras.length && used < LEAD_CHARS; i++) {
    keep.add(i);
    used += paras[i]!.length + 1;
  }
  // Best first; a short line just before a kept paragraph (its heading) comes with it.
  const order = paras.map((_, i) => i).filter((i) => scores[i]! > 0 && !keep.has(i)).sort((a, b) => scores[b]! - scores[a]! || a - b);
  for (const i of order) {
    const heading = i > 0 && !keep.has(i - 1) && paras[i - 1]!.length < 80 ? i - 1 : null;
    const cost = paras[i]!.length + 1 + (heading !== null ? paras[heading]!.length + 1 : 0);
    if (used + cost > max) continue;
    keep.add(i);
    if (heading !== null) keep.add(heading);
    used += cost;
  }
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last >= 0 && i > last + 1) out.push("…");
    out.push(paras[i]!);
    last = i;
  }
  if (last < paras.length - 1) out.push("…");
  return { text: out.join("\n"), selected: true };
}
