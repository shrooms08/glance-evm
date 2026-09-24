/**
 * Show me's drawings on Glance's own charts, handed from the reply to whichever chart is showing that stock. A drawing
 * that fires before its chart has loaded waits here and is applied as soon as the chart mounts. Cleared on Escape, a
 * few seconds after the reply ends, or when the chart's range changes.
 */
import type { ChartRange } from "@glance/core/chart";
import type { ChartAnnotation } from "@glance/core/showme";

/** After a reply ends, its chart drawings stay this long. */
export const CHART_DRAWINGS_MS = 6_000;

type Listener = (change: { add: ChartAnnotation[] } | { clear: true }) => void;

export class ChartAnnotations {
  private pending = new Map<string, ChartAnnotation[]>();
  private listeners = new Map<string, Set<Listener>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The chart showing now (the floating or side panel's), for Show me's context. */
  showing: { symbol: string; range: ChartRange } | null = null;

  annotate(a: ChartAnnotation) {
    clearTimeout(this.timer);
    const list = this.pending.get(a.symbol) ?? [];
    list.push(a);
    this.pending.set(a.symbol, list);
    for (const l of this.listeners.get(a.symbol) ?? []) l({ add: [a] });
  }

  /** A chart for `symbol` subscribes: it gets what's already waiting, then each new drawing. */
  subscribe(symbol: string, l: Listener): () => void {
    const set = this.listeners.get(symbol) ?? new Set();
    set.add(l);
    this.listeners.set(symbol, set);
    const waiting = this.pending.get(symbol);
    if (waiting?.length) l({ add: [...waiting] });
    return () => set.delete(l);
  }

  clear(symbol?: string) {
    clearTimeout(this.timer);
    const symbols = symbol ? [symbol] : [...new Set([...this.pending.keys(), ...this.listeners.keys()])];
    for (const s of symbols) {
      this.pending.delete(s);
      for (const l of this.listeners.get(s) ?? []) l({ clear: true });
    }
  }

  clearLater(ms = CHART_DRAWINGS_MS) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.clear(), ms);
  }
}

export const chartAnnotations = new ChartAnnotations();
