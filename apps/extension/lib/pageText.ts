/**
 * Collects the page's visible text, remembers which text node each character came from, and turns API offsets back
 * into DOM Ranges. It never modifies the page: underlines are drawn with the CSS Custom Highlight API.
 */

export interface Segment {
  node: Text;
  /** Offset of the node's first character in the collected text. */
  start: number;
  end: number;
}

export interface Collected {
  text: string;
  segments: Segment[];
}

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "CANVAS", "IFRAME",
  "OBJECT", "CODE", "KBD", "SAMP", "HEAD", "TITLE",
]);
const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH", "TR", "TABLE", "SECTION", "ARTICLE",
  "ASIDE", "HEADER", "FOOTER", "NAV", "MAIN", "BLOCKQUOTE", "FIGCAPTION", "FIGURE", "DD", "DT", "DL", "PRE", "FORM",
  "BUTTON", "LABEL", "BODY",
]);

function blockOf(node: Node): Element | null {
  let el = node.parentElement;
  while (el && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
  return el;
}

export interface CollectOptions {
  /** Elements to leave out entirely (our own UI host). */
  exclude?: Element | null;
  /** Stop after this many characters. */
  maxChars?: number;
  /** Visibility test; defaults to Element.checkVisibility where available. */
  isVisible?: (el: Element) => boolean;
}

export function collectText(root: Element, opts: CollectOptions = {}): Collected {
  const max = opts.maxChars ?? 120_000;
  const visibleCache = new WeakMap<Element, boolean>();
  const visible =
    opts.isVisible ??
    ((el: Element) => {
      const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
      return check ? check.call(el, { visibilityProperty: true, opacityProperty: false }) : true;
    });

  const accept = (el: Element | null): boolean => {
    for (let e = el; e && e !== root.parentElement; e = e.parentElement) {
      if (e === opts.exclude) return false;
      if (SKIP_TAGS.has(e.tagName)) return false;
      if (e.getAttribute("contenteditable") === "true" || e.getAttribute("aria-hidden") === "true") return false;
    }
    if (!el) return false;
    let v = visibleCache.get(el);
    if (v === undefined) {
      v = visible(el);
      visibleCache.set(el, v);
    }
    return v;
  };

  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() && accept(n.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });

  let text = "";
  const segments: Segment[] = [];
  let lastBlock: Element | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const block = blockOf(n);
    // A separator between blocks keeps "Tesla" in one paragraph from fusing with a word in the next.
    if (text && block !== lastBlock) text += "\n";
    lastBlock = block;
    const value = n.nodeValue ?? "";
    if (text.length + value.length > max) break;
    segments.push({ node: n, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, segments };
}

/** Index of the segment containing `offset` (binary search), or -1. */
function segmentAt(segments: readonly Segment[], offset: number, preferEnd = false): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid]!;
    if (offset < s.start || (preferEnd && offset === s.start && mid > 0 && segments[mid - 1]!.end === offset)) hi = mid - 1;
    else if (offset > s.end || (!preferEnd && offset === s.end && mid < segments.length - 1 && segments[mid + 1]!.start === offset)) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** A DOM Range covering [start, end) of the collected text, or null if it falls in a separator. */
export function rangeFor(doc: Document, segments: readonly Segment[], start: number, end: number): Range | null {
  const a = segmentAt(segments, start);
  const b = segmentAt(segments, end, true);
  if (a < 0 || b < 0) return null;
  const sa = segments[a]!;
  const sb = segments[b]!;
  // The first character must lie inside a node (not at a node's end), and so must the last.
  if (start < sa.start || start >= sa.end || end > sb.end || end <= sb.start) return null;
  const range = doc.createRange();
  range.setStart(sa.node, start - sa.start);
  range.setEnd(sb.node, end - sb.start);
  return range;
}

/** Splits collected text into chunks under the API's request limit, on segment boundaries. */
export function chunks(c: Collected, limit = 18_000): Array<{ offset: number; text: string }> {
  const out: Array<{ offset: number; text: string }> = [];
  let startSeg = 0;
  while (startSeg < c.segments.length) {
    const offset = c.segments[startSeg]!.start;
    let endSeg = startSeg;
    while (endSeg + 1 < c.segments.length && c.segments[endSeg + 1]!.end - offset <= limit) endSeg++;
    const end = Math.min(c.segments[endSeg]!.end, offset + limit);
    out.push({ offset, text: c.text.slice(offset, end) });
    startSeg = endSeg + 1;
  }
  return out;
}
