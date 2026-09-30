/**
 * How long Show me's marks live, on the page and on a chart: for the whole answer and after it. They go only on
 * Escape, the x, the next question, navigation, or (on a chart) its range changing (lib/chartLayer.ts); never on a
 * timer.
 */
export interface MarkSurfaces {
  /** The page's marks (lib/showDraw.ts). */
  clearPage(): void;
  /** Marks on Glance's own chart (lib/chartAnnotations.ts). */
  clearCharts(): void;
  /** The page chart's layer (lib/chartLayer.ts), when the answer was about one. */
  closeLayer?(): void;
}

/** An answer ended: cancelled (Escape, the x, the next question) clears everything; finished keeps it all. */
export function afterAnswer(cancelled: boolean, s: MarkSurfaces): "cleared" | "kept" {
  if (!cancelled) return "kept";
  s.clearPage();
  s.clearCharts();
  s.closeLayer?.();
  return "cleared";
}

/** Calls `onNavigate` when the page's URL changes (single-page sites change it without a reload). Returns a stop. */
export function watchNavigation(win: Pick<Window, "location" | "setInterval" | "clearInterval">, onNavigate: () => void, everyMs = 800): () => void {
  let href = win.location.href;
  const id = win.setInterval(() => {
    if (win.location.href === href) return;
    href = win.location.href;
    onNavigate();
  }, everyMs);
  return () => win.clearInterval(id);
}
