/**
 * What "Show me" sends about the page, only when the user asks: the title, the host, their selection, the visible
 * main text (readability-style: the article or main element with the most text, else the body, minus navigation,
 * footers and asides), capped at SHOW_ME_MAX_CHARS (about 6,000 tokens), and the companies Glance underlined.
 *
 * Never the DOM, and never anything typed: forms, inputs, text areas, selects, editable regions, and anything that
 * looks like a password or payment field (and everything inside them) are skipped. Our own UI is skipped too.
 */

export const SHOW_ME_MAX_CHARS = 24_000;
const SELECTION_MAX = 2_000;

/** A visible figure, numbered from 1 in page order: what it is, its alt text, caption and nearest heading. No pixels. */
export interface PageFigure {
  n: number;
  kind: "image" | "canvas" | "chart" | "video";
  alt?: string;
  caption?: string;
  heading?: string;
  width: number;
  height: number;
}

export interface PageRead {
  title: string;
  host: string;
  selection?: string;
  text: string;
  companies: string[];
  figures?: PageFigure[];
}

export const MAX_FIGURES = 12;

/**
 * The visible figures (images, canvases, SVG charts, video posters at least 80 by 60 on screen), in page order, at most
 * MAX_FIGURES: the list Show me sends, and the elements behind each number, for [BOX_FIGURE:n].
 */
export function listFigures(doc: Document, win: Window = window): { figures: PageFigure[]; elements: Element[] } {
  const figures: PageFigure[] = [];
  const elements: Element[] = [];
  for (const el of doc.querySelectorAll("img, canvas, svg, video")) {
    if (figures.length >= MAX_FIGURES) break;
    if (el.tagName === "svg" && el.parentElement?.closest("svg")) continue; // nested svg
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 60) continue;
    if (r.bottom < 0 || r.top > win.innerHeight * 3) continue; // far below: not something to point at now
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const kind = tag === "img" ? "image" : tag === "canvas" ? "canvas" : tag === "video" ? "video" : "chart";
    const caption = el.closest("figure")?.querySelector("figcaption")?.textContent?.replace(/\s+/g, " ").trim();
    const heading = nearestHeading(el);
    const alt = (el.getAttribute("alt") ?? el.getAttribute("aria-label") ?? el.querySelector?.("title")?.textContent ?? "").replace(/\s+/g, " ").trim();
    figures.push({
      n: figures.length + 1,
      kind,
      ...(alt ? { alt: alt.slice(0, 200) } : {}),
      ...(caption ? { caption: caption.slice(0, 300) } : {}),
      ...(heading ? { heading: heading.slice(0, 200) } : {}),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
    elements.push(el);
  }
  return { figures, elements };
}

/** The closest heading before an element in the document. */
function nearestHeading(el: Element): string | undefined {
  const heads = [...el.ownerDocument.querySelectorAll("h1, h2, h3, h4")];
  let found: Element | undefined;
  for (const h of heads) {
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = h;
    else break;
  }
  return found?.textContent?.replace(/\s+/g, " ").trim() || undefined;
}

/** Elements whose text is never read (and never is anything inside them). */
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "HEAD", "TITLE", "FORM", "INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "NAV", "FOOTER", "ASIDE"]);
/** Autocomplete tokens and names that mean a secret or a payment detail. */
const SENSITIVE = /password|passwd|cc-|card|cvc|cvv|iban|account-number|one-time-code|otp|pin\b|ssn|security-code/i;

function sensitive(el: Element): boolean {
  if (el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "") return true;
  if (el.getAttribute("aria-hidden") === "true" || (el as HTMLElement).hidden) return true;
  const hints = `${el.getAttribute("type") ?? ""} ${el.getAttribute("autocomplete") ?? ""} ${el.getAttribute("name") ?? ""} ${el.id} ${el.getAttribute("data-testid") ?? ""}`;
  return SENSITIVE.test(hints) && (el.matches("input, textarea, select, [role=textbox]") || el.querySelector("input, select") !== null);
}

function visible(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  return check ? check.call(el, { visibilityProperty: true, opacityProperty: true }) : true;
}

/** The readable text under `root`, block elements separated by newlines. */
export function readableText(root: Element, exclude: Element | null = null, max = SHOW_ME_MAX_CHARS): string {
  const doc = root.ownerDocument;
  const skipCache = new WeakMap<Element, boolean>();
  // A password or payment field's own container (its label, "Card on file", the last four digits) is skipped with it.
  for (const field of root.querySelectorAll("input, select, textarea, [role=textbox]")) {
    if (sensitive(field) && field.parentElement && field.parentElement !== root) skipCache.set(field.parentElement, true);
  }
  const skipped = (el: Element | null): boolean => {
    for (let e = el; e && e !== root.parentElement; e = e.parentElement) {
      const known = skipCache.get(e);
      if (known !== undefined) return known;
      const skip = e === exclude || SKIP.has(e.tagName) || sensitive(e) || !visible(e);
      if (skip) {
        skipCache.set(e, true);
        return true;
      }
    }
    if (el) skipCache.set(el, false);
    return false;
  };
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue?.trim() && !skipped(n.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let out = "";
  let lastBlock: Element | null = null;
  for (let n = walker.nextNode(); n && out.length < max; n = walker.nextNode()) {
    const block = n.parentElement?.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, td, th, dd, dt, pre, div, section, article") ?? null;
    if (out && block !== lastBlock) out += "\n";
    lastBlock = block;
    out += n.nodeValue!.replace(/\s+/g, " ");
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim().slice(0, max);
}

/** The main content element: the article/main candidate with the most text, else the body. */
export function mainElement(doc: Document): Element {
  const candidates = [...doc.querySelectorAll("article, main, [role=main]")];
  let best: Element | null = null;
  let bestLen = 0;
  for (const c of candidates) {
    const len = (c.textContent ?? "").length;
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  // A tiny <main> (a cookie banner) isn't the article: require a real amount of text.
  return best && bestLen > 400 ? best : doc.body;
}

export function readPage(doc: Document, opts: { exclude?: Element | null; companies?: string[]; figures?: PageFigure[] } = {}): PageRead {
  const sel = doc.getSelection?.();
  // A selection inside a form field is never sent.
  const anchor = sel?.anchorNode ? (sel.anchorNode.nodeType === 1 ? (sel.anchorNode as Element) : sel.anchorNode.parentElement) : null;
  const selection = anchor && !anchor.closest("form, input, textarea, select, [contenteditable]") ? (sel?.toString() ?? "").trim().slice(0, SELECTION_MAX) : "";
  return {
    title: (doc.title ?? "").trim().slice(0, 300),
    host: doc.location?.hostname.replace(/^www\./, "") ?? "",
    ...(selection ? { selection } : {}),
    text: readableText(mainElement(doc), opts.exclude ?? null),
    companies: opts.companies ?? [],
    ...(opts.figures?.length ? { figures: opts.figures } : {}),
  };
}

/** Questions about a chart or an image get a screenshot of the visible tab; nothing else does. */
export function wantsScreenshot(question: string): boolean {
  return /\b(chart|charts|graph|graphs|image|images|picture|photo|figure|diagram|plot|screenshot|candles?)\b/i.test(question);
}
