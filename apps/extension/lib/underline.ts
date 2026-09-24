/**
 * Finds catalog companies in the page and underlines them without touching the page's DOM: text is collected
 * read-only, sent to POST /resolve, and the returned offsets are drawn with the CSS Custom Highlight API. Layout,
 * selection, copy and the page's own scripts are unaffected. Re-runs on DOM changes, debounced, with a per-chunk cache
 * so an unchanged article is never re-sent.
 *
 * Passive scans (page load, DOM changes) use the dictionary only: /resolve never calls Claude. Only a glance (Option+G,
 * the orb, or the panel opening on this page) may ask Claude, with one request carrying every unresolved candidate
 * name on the page (POST /resolve/names). Names it confirms are underlined from then on, by later scans too.
 */
import { api } from "./api";
import { companyCandidates, occurrences } from "./candidates";
import { log } from "./log";
import { chunks, collectText, rangeFor } from "./pageText";
import { focusRule, fontFaces, highlightRule, isLightColor } from "./tokens";

export const HIGHLIGHT = "glance-company";
const FOCUS = "glance-focus";
const RESCAN_DEBOUNCE_MS = 1_200;
const MIN_SCAN_INTERVAL_MS = 3_000;

export interface Mention {
  symbol: string;
  range: Range;
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
declare const Highlight: new (...ranges: Range[]) => unknown;

function registry(): HighlightRegistry | null {
  const css = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights && typeof Highlight !== "undefined" ? css.highlights : null;
}

/** Page-scope styles: our fonts under Glance-only names, and the rule for our named highlights. Nothing else. */
export function injectPageStyles(assetUrl: (path: string) => string) {
  const id = "glance-page-styles";
  document.getElementById(id)?.remove();
  const style = document.createElement("style");
  style.id = id;
  const light = isLightColor(getComputedStyle(document.body).backgroundColor) && isLightColor(getComputedStyle(document.documentElement).backgroundColor);
  style.textContent = `${fontFaces(assetUrl)}\n${highlightRule(HIGHLIGHT, light)}\n${focusRule(FOCUS, light)}`;
  (document.head ?? document.documentElement).append(style);
}

export class Underliner {
  private mentions: Mention[] = [];
  private cache = new Map<string, Array<{ symbol: string; start: number; end: number }>>();
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastScan = 0;
  private scanning = false;
  private listeners = new Set<(mentions: Mention[]) => void>();
  /** Names Claude confirmed on this page (name -> symbol), and every name already asked (lowercased). */
  private named = new Map<string, string>();
  private asked = new Set<string>();
  /** The last scan's text and dictionary matches, for picking a glance's candidates. */
  private last: { text: string; matched: Array<{ start: number; end: number }> } = { text: "", matched: [] };

  constructor(private readonly exclude: Element) {}

  start() {
    void this.scan();
    this.observer = new MutationObserver((records) => {
      // Ignore our own UI, and pure attribute churn.
      if (records.every((r) => this.exclude.contains(r.target))) return;
      this.schedule();
    });
    // The whole document, not <body>: some sites replace <body> itself when they re-render.
    this.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  stop() {
    this.observer?.disconnect();
    clearTimeout(this.timer);
    this.timer = undefined;
    registry()?.delete(HIGHLIGHT);
  }

  onChange(cb: (mentions: Mention[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  current(): Mention[] {
    // Pages swap text nodes under us (live blogs, hydration); drop mentions whose text has gone, and rescan.
    const live = this.mentions.filter((m) => !m.range.collapsed && m.range.startContainer.isConnected);
    if (live.length < this.mentions.length) this.schedule();
    return live;
  }

  /**
   * One rescan per burst of changes. A plain debounce would starve on pages that mutate constantly (ads, live
   * counters): every change would push the scan back forever. Here the first change schedules a scan and later changes
   * ride along with it, and scans stay at least MIN_SCAN_INTERVAL_MS apart.
   */
  private schedule() {
    if (this.timer !== undefined) return;
    const wait = Math.max(RESCAN_DEBOUNCE_MS, MIN_SCAN_INTERVAL_MS - (Date.now() - this.lastScan));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.scan();
    }, wait);
  }

  async scan() {
    if (this.scanning || document.visibilityState === "hidden") return this.schedule();
    this.scanning = true;
    this.lastScan = Date.now();
    try {
      const collected = collectText(document.body, { exclude: this.exclude });
      const found: Mention[] = [];
      const matched: Array<{ start: number; end: number }> = [];
      const add = (symbol: string, start: number, end: number) => {
        const range = rangeFor(document, collected.segments, start, end);
        if (range && !range.collapsed && range.toString().trim()) found.push({ symbol, range });
      };
      for (const chunk of chunks(collected)) {
        let matches = this.cache.get(chunk.text);
        if (!matches) {
          const res = await api.resolve(chunk.text);
          if (!res.ok) {
            log("resolve failed", res.code);
            break;
          }
          matches = res.data.matches.map((m) => ({ symbol: m.symbol, start: m.start, end: m.end }));
          this.cache.set(chunk.text, matches);
        }
        for (const m of matches) {
          matched.push({ start: chunk.offset + m.start, end: chunk.offset + m.end });
          add(m.symbol, chunk.offset + m.start, chunk.offset + m.end);
        }
      }
      // Names a glance confirmed: found locally, no request.
      for (const [name, symbol] of this.named) {
        for (const o of occurrences(collected.text, name)) {
          if (matched.some((m) => o.start < m.end && o.end > m.start)) continue;
          add(symbol, o.start, o.end);
        }
      }
      this.last = { text: collected.text, matched };
      this.mentions = found;
      registry()?.set(HIGHLIGHT, new Highlight(...found.map((m) => m.range)));
      for (const cb of this.listeners) cb(found);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * A glance: rescan, then ask about the page's unresolved candidate names in ONE request (none if there are no new
   * ones), and underline the names that turn out to be listed companies.
   */
  async glance() {
    await this.scan();
    const candidates = companyCandidates(this.last.text, this.last.matched, this.asked);
    if (candidates.length === 0) return;
    for (const c of candidates) this.asked.add(c.toLowerCase());
    const res = await api.resolveNames(candidates);
    if (!res.ok) {
      log("resolve names failed", res.code);
      return;
    }
    if (res.data.names.length === 0) return;
    for (const n of res.data.names) this.named.set(n.name, n.symbol);
    await this.scan();
  }

  /** The mention under a viewport point, if any. */
  hitTest(x: number, y: number): Mention | null {
    if (this.mentions.length === 0) return null;
    const caret = document.caretRangeFromPoint?.(x, y);
    if (!caret) return null;
    for (const m of this.current()) {
      try {
        if (m.range.comparePoint(caret.startContainer, caret.startOffset) !== 0) continue;
      } catch {
        continue; // the range's nodes left the document
      }
      // caretRangeFromPoint snaps to the nearest text even in margins; require the point to be on the words.
      for (const r of m.range.getClientRects()) {
        if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 2 && y <= r.bottom + 2) return m;
      }
    }
    return null;
  }

  /** Scrolls the first mention of `symbol` into view and briefly emphasises it. */
  reveal(symbol: string) {
    const m = this.mentions.find((x) => x.symbol === symbol);
    if (!m) return;
    const el = m.range.startContainer.parentElement;
    el?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const reg = registry();
    if (!reg) return;
    reg.set(FOCUS, new Highlight(m.range));
    setTimeout(() => reg.delete(FOCUS), 2_000);
  }
}
