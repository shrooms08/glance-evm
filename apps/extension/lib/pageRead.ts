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

export interface PageRead {
  title: string;
  host: string;
  selection?: string;
  text: string;
  companies: string[];
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

export function readPage(doc: Document, opts: { exclude?: Element | null; companies?: string[] } = {}): PageRead {
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
  };
}

/** Questions about a chart or an image get a screenshot of the visible tab; nothing else does. */
export function wantsScreenshot(question: string): boolean {
  return /\b(chart|charts|graph|graphs|image|images|picture|photo|figure|diagram|plot|screenshot|candles?)\b/i.test(question);
}
