/**
 * Splits streamed text into sentences as it arrives, so the first one can be spoken while the rest is still being
 * written. A sentence ends at . ! or ? followed by a space (or the end), except inside a tag ("[...]": a tag is never
 * split, so a partial tag is never spoken), in numbers ("$3.50", "18.4%"), and after common abbreviations ("U.S.",
 * "Inc.", "e.g.", "Mr."). With no end in sight, a sentence past MAX_SENTENCE characters is cut at its last comma.
 */

export const MAX_SENTENCE = 120;

/** Words whose trailing period doesn't end a sentence. */
const ABBREVIATIONS = new Set(
  ["u.s", "u.k", "e.g", "i.e", "vs", "etc", "inc", "corp", "co", "ltd", "mr", "mrs", "ms", "dr", "st", "jr", "sr", "no", "approx", "est", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "a.m", "p.m"].map((s) => s.toLowerCase()),
);

export class SentenceSplitter {
  private buffer = "";

  /** Adds streamed text; returns every sentence it completed (trimmed, never empty). */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (let s = this.next(); s !== null; s = this.next()) out.push(s);
    return out;
  }

  /** The stream ended: whatever is left is the last sentence (if any). */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }

  private next(): string | null {
    const b = this.buffer;
    let depth = 0;
    let lastComma = -1;
    for (let i = 0; i < b.length; i++) {
      const ch = b[i]!;
      if (ch === "[") depth++;
      else if (ch === "]") depth = Math.max(0, depth - 1);
      if (depth > 0) continue;
      if (ch === "," && i >= 60) lastComma = i;
      if (ch === "." || ch === "!" || ch === "?") {
        const after = b[i + 1];
        if (after === undefined) return null; // can't tell yet: more may come ("$3" + ".50")
        if (!/[\s"'”’)\]]/.test(after)) continue; // "3.50", "U.S" mid-word, "Amazon.com"
        // Closing quotes or brackets right after the stop belong to this sentence.
        let end = i + 1;
        while (end < b.length && /["'”’)]/.test(b[end]!)) end++;
        if (end >= b.length) return null;
        if (ch === "." && this.abbreviation(b, i)) continue;
        return this.take(end);
      }
      if (i >= MAX_SENTENCE && lastComma > 0) return this.take(lastComma + 1);
    }
    return null;
  }

  /** The word ending at `dot` is an abbreviation ("U.S.", "Inc.") or a single initial ("J."). */
  private abbreviation(b: string, dot: number): boolean {
    let start = dot;
    while (start > 0 && /[A-Za-z.]/.test(b[start - 1]!)) start--;
    const word = b.slice(start, dot).toLowerCase();
    if (ABBREVIATIONS.has(word)) return true;
    return /^[a-z]$/.test(word) && /^[A-Z]$/.test(b.slice(start, dot)); // an initial
  }

  private take(end: number): string | null {
    const sentence = this.buffer.slice(0, end).trim();
    this.buffer = this.buffer.slice(end);
    return sentence ? sentence : this.next();
  }
}

/** Splits a whole text into sentences (the streaming splitter, fed at once). */
export function splitSentences(text: string): string[] {
  const s = new SentenceSplitter();
  return [...s.push(text), ...s.flush()];
}
