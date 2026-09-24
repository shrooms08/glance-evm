/**
 * Finds a quoted phrase on the page for "Show me": a text search over the page's visible text nodes (a TreeWalker),
 * tolerant of whitespace and case, first visible match wins. Returns a DOM Range over the words, or null (the drawing
 * is then skipped and Glance keeps talking). Our own UI is never searched.
 */
import { looseText } from "@glance/core/showme";

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "TEXTAREA", "INPUT", "SELECT", "OPTION"]);

interface Piece {
  node: Text;
  /** Offset in the node for each character of the normalized text. */
  map: number[];
  start: number;
}

function visible(el: Element | null): boolean {
  if (!el) return false;
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  return check ? check.call(el, { visibilityProperty: true, opacityProperty: true }) : true;
}

/**
 * The page's text, normalized like looseText (lowercase, runs of whitespace as one space), with a map from each
 * normalized character back to its text node and offset.
 */
function normalizedText(root: Element, exclude: Element | null): { text: string; pieces: Piece[] } {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      for (let e = n.parentElement; e; e = e.parentElement) {
        if (e === exclude || SKIP.has(e.tagName)) return NodeFilter.FILTER_REJECT;
      }
      return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let text = "";
  let lastSpace = true; // nothing yet: leading whitespace is dropped
  const pieces: Piece[] = [];
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const raw = n.nodeValue!;
    const map: number[] = [];
    const start = text.length;
    let local = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (/\s/.test(ch)) {
        // One space for a run of whitespace, across node boundaries too.
        if (lastSpace) continue;
        lastSpace = true;
        local += " ";
        map.push(i);
      } else {
        lastSpace = false;
        const low = looseText(ch) || ch.toLowerCase();
        for (let k = 0; k < low.length; k++) {
          local += low[k];
          map.push(i);
        }
      }
    }
    if (!local) continue;
    pieces.push({ node: n, map, start });
    text += local;
  }
  return { text, pieces };
}

function locate(pieces: Piece[], at: number): { node: Text; offset: number } | null {
  for (const p of pieces) {
    if (at >= p.start && at < p.start + p.map.length) return { node: p.node, offset: p.map[at - p.start]! };
  }
  return null;
}

/** The first visible occurrence of `quote` under `root`, as a Range, or null. */
export function findQuote(root: Element, quote: string, exclude: Element | null = null): Range | null {
  const want = looseText(quote);
  if (!want) return null;
  const { text, pieces } = normalizedText(root, exclude);
  for (let from = text.indexOf(want); from >= 0; from = text.indexOf(want, from + 1)) {
    const a = locate(pieces, from);
    const b = locate(pieces, from + want.length - 1);
    if (!a || !b) continue;
    if (!visible(a.node.parentElement)) continue;
    const range = root.ownerDocument.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, Math.min(b.offset + 1, b.node.length));
    return range;
  }
  return null;
}

/** Scrolls the range into view, smoothly, if it's off screen. Returns whether it scrolled. */
export function revealRange(range: Range, win: Window = window): boolean {
  const r = range.getBoundingClientRect();
  const h = win.innerHeight;
  if (r.bottom > 0 && r.top < h && !(r.width === 0 && r.height === 0 && r.top === 0)) return false;
  const el = range.startContainer.parentElement;
  const reduced = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  return true;
}

/** The start of the sentence after `range` (up to about 40 characters), for the test drawing's arrow; null at the end. */
export function nextSentence(range: Range): Range | null {
  const doc = range.startContainer.ownerDocument!;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  walker.currentNode = range.endContainer;
  let node: Node | null = range.endContainer;
  let offset = range.endOffset;
  let passedEnd = false;
  for (let hops = 0; node && hops < 50; hops++) {
    const text = node.nodeValue ?? "";
    for (let i = offset; i < text.length; i++) {
      if (!passedEnd) {
        if (/[.!?]/.test(text[i]!)) passedEnd = true;
        continue;
      }
      if (/\S/.test(text[i]!)) {
        const r = doc.createRange();
        r.setStart(node, i);
        r.setEnd(node, Math.min(text.length, i + 40));
        return r;
      }
    }
    node = walker.nextNode();
    offset = 0;
    passedEnd = true; // a new block counts as a new sentence
  }
  return null;
}
