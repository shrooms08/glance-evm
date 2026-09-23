/**
 * Every dollar amount a transcript actually contains. The intent step may only use an amount from this list: a model
 * can never introduce one the user did not say.
 *
 *   "$25", "25 dollars", "25.50", "2,500", "ten", "twenty five", "a hundred", "one hundred and fifty", "fifty bucks"
 */

const ONES: Record<string, number> = {
  one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMBER_WORD = new Set([...Object.keys(ONES), ...Object.keys(TENS), "hundred", "thousand", "and"]);

/** Normalises a decimal string: "025" -> "25", "12.50" -> "12.5", "10.00" -> "10". Null for zero or junk. */
export function canonicalAmount(raw: string): string | null {
  const t = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  if (!(n > 0) || n > 1_000_000) return null;
  return String(n);
}

/**
 * Spoken number words -> a number: "twenty five" -> 25, "a hundred and fifty" -> 150. Null if not all number words,
 * or if the words don't make one unambiguous number ("twelve fifty" could be $12.50 or $1,250: we ask instead).
 */
export function wordsToNumber(words: string[]): number | null {
  const ws = words.filter((w) => w !== "and");
  if (ws.length === 0) return null;
  // "a" or "an" only count as one when followed by hundred/thousand ("a hundred"), never on their own ("buy a tesla").
  if (ws.length === 1 && (ws[0] === "a" || ws[0] === "an")) return null;
  let total = 0;
  let current = 0;
  // What the last word was, to refuse sequences that aren't one number: "twelve fifty" ($12.50? $1,250?), "five ten".
  let last: "none" | "ones" | "tens" | "scale" = "none";
  for (const w of ws) {
    if (w in ONES) {
      if (last === "ones") return null; // "five ten", "twelve three"
      current += ONES[w]!;
      last = "ones";
      continue;
    }
    if (w in TENS) {
      if (last === "ones" || last === "tens") return null; // "twelve fifty", "twenty thirty"
      current += TENS[w]!;
      last = "tens";
      continue;
    }
    last = "scale";
    if (w === "hundred") current = (current || 1) * 100;
    else if (w === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
    } else return null;
  }
  const n = total + current;
  return n > 0 ? n : null;
}

/** All amounts in a transcript, in order, as canonical decimal strings (duplicates removed). */
export function extractAmounts(transcript: string): string[] {
  const out: string[] = [];
  const add = (a: string | null) => {
    if (a && !out.includes(a)) out.push(a);
  };
  const text = transcript.toLowerCase().replace(/[’']/g, "'");
  // Digits, with an optional $ and thousands separators: "$25", "2,500", "12.50".
  for (const m of text.matchAll(/\$?\d[\d,]*(?:\.\d{1,2})?/g)) add(canonicalAmount(m[0]));
  // Runs of number words: "twenty five", "a hundred and fifty".
  const words = text.replace(/-/g, " ").split(/[^a-z]+/).filter(Boolean);
  let run: string[] = [];
  const flush = () => {
    while (run.length && run[run.length - 1] === "and") run.pop();
    const n = wordsToNumber(run);
    if (n !== null) add(String(n));
    run = [];
  };
  for (const w of words) {
    if (NUMBER_WORD.has(w) && !(run.length === 0 && w === "and")) run.push(w);
    else flush();
  }
  flush();
  return out;
}
