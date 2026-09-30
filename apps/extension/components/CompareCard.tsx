/**
 * "Compare Tesla and AMD this week": each stock's line rebased to 100 at the range's start (so they start together and
 * the gap is the difference in % moves), in the design system's comparison colors and dashes, with a legend, and the
 * three numbers side by side: change %, deepest fall from a peak, how bumpy. Every number comes from GET
 * /chart/:symbols/facts (computed in code). Plain SVG: no chart library needed.
 */
import { CHART_RANGES, compareSeries, type ChartRange } from "@glance/core/chart";
import { pct, REBASED_LABEL } from "@glance/core/chart-facts";
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import type { ChartFactsView } from "../lib/api-types";
import { isAddress } from "../lib/settings";
import { useGlance } from "./context";

const W = 320;
const H = 140;
const PAD = 6;

type Comparison = NonNullable<ChartFactsView["comparison"]>;

/** The lines as SVG paths (stepped, like the price chart), on shared time and value axes; y for the 100 baseline. */
export function comparePaths(lines: Comparison["lines"], width = W, height = H, pad = PAD): { paths: string[]; baseline: number; lo: number; hi: number } {
  const all = lines.flatMap((l) => l.points);
  if (all.length === 0) return { paths: lines.map(() => ""), baseline: height / 2, lo: 100, hi: 100 };
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const lo = Math.min(100, ...all.map((p) => p.value));
  const hi = Math.max(100, ...all.map((p) => p.value));
  const x = (t: number) => pad + ((t - t0) / (t1 - t0 || 1)) * (width - 2 * pad);
  const y = (v: number) => (hi === lo ? height / 2 : pad + (1 - (v - lo) / (hi - lo)) * (height - 2 * pad));
  const paths = lines.map((l) => {
    if (l.points.length === 0) return "";
    let d = `M${x(l.points[0]!.t).toFixed(1)},${y(l.points[0]!.value).toFixed(1)}`;
    for (const p of l.points.slice(1)) d += `H${x(p.t).toFixed(1)}V${y(p.value).toFixed(1)}`;
    return d;
  });
  return { paths, baseline: y(100), lo, hi };
}

const signed = (n: number) => (n > 0 ? `+${pct(n)}` : n < 0 ? `-${pct(n)}` : "0.00%");

export function CompareView({ view }: { view: ChartFactsView }) {
  const c = view.comparison;
  if (!c) return null;
  const series = compareSeries("dark");
  const { paths, baseline, lo, hi } = comparePaths(c.lines);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${c.lines.map((l) => l.name).join(", ")}, ${REBASED_LABEL}`} data-testid="compare-chart">
        <line x1={PAD} x2={W - PAD} y1={baseline} y2={baseline} className="g-compare-base" strokeDasharray="1 3" />
        {paths.map((d, i) => (
          <path key={c.lines[i]!.symbol} d={d} fill="none" stroke={series[i]!.color} strokeWidth={1.75} strokeDasharray={series[i]!.dash || undefined} data-symbol={c.lines[i]!.symbol} />
        ))}
      </svg>
      <div className="g-between">
        <span className="g-meta">{REBASED_LABEL} at the start</span>
        <span className="g-data">
          {lo.toFixed(2)} to {hi.toFixed(2)}
        </span>
      </div>
      <div className="g-row" role="list" aria-label="Legend" style={{ flexWrap: "wrap", gap: 12 }}>
        {c.lines.map((l, i) => (
          <span key={l.symbol} role="listitem" className="g-row" style={{ gap: 6 }}>
            <svg width="22" height="6" aria-hidden>
              <line x1="0" x2="22" y1="3" y2="3" stroke={series[i]!.color} strokeWidth={2} strokeDasharray={series[i]!.dash || undefined} />
            </svg>
            <span className="g-ui">{l.name}</span>
            <span className="g-ticker">{l.symbol}</span>
          </span>
        ))}
      </div>
      <table className="g-compare-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col" className="g-meta">Change</th>
            <th scope="col" className="g-meta">Deepest fall</th>
            <th scope="col" className="g-meta">How bumpy</th>
          </tr>
        </thead>
        <tbody>
          {c.rows.map((r) => (
            <tr key={r.symbol} data-row={r.symbol}>
              <th scope="row" className="g-ticker">
                {r.symbol}
              </th>
              <td className={`g-data ${r.changePct > 0 ? "g-up" : r.changePct < 0 ? "g-down" : ""}`}>{signed(r.changePct)}</td>
              <td className="g-data">{r.maxDrawdownPct === 0 ? "none" : `-${pct(r.maxDrawdownPct)}`}</td>
              <td className="g-data">
                {pct(r.bumpiness.stdevPct)} · {r.bumpiness.label}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <span className="g-meta">&ldquo;How bumpy&rdquo; is the typical move between two published prices.</span>
    </div>
  );
}

/** The card: loads the comparison (or shows the one already fetched), with 1D / 1W / 1M. */
/** `market`: from the market's own candles (a stock outside the catalog is in it), the same source for every line. */
export function CompareCard({ symbols, range: initial, data, market, onClose }: { symbols: string[]; range: ChartRange; data?: ChartFactsView; market?: boolean; onClose?(): void }) {
  const g = useGlance();
  const [range, setRange] = useState(initial);
  const [view, setView] = useState<ChartFactsView | null>(data && data.range === initial ? data : null);
  const [error, setError] = useState<string | null>(null);
  const vault = isAddress(g.vaultAddress) ? g.vaultAddress : undefined;
  useEffect(() => {
    if (view && view.range === range) return;
    let live = true;
    setError(null);
    void api.chartFacts(symbols, range, vault, market ? { market: true } : undefined).then((res) => {
      if (!live) return;
      if (res.ok) setView(res.data);
      else setError(res.message);
    });
    return () => {
      live = false;
    };
  }, [symbols, range, vault, view, market]);
  return (
    <div className="g-card" role="region" aria-label="Comparison">
      <div className="g-section" style={{ gap: 10 }}>
        <div className="g-between">
          <span className="g-ui">Compare</span>
          <div className="g-row">
            <div className="g-tabs" role="tablist" aria-label="Range">
              {CHART_RANGES.map((r) => (
                <button key={r} role="tab" aria-selected={r === range} className="g-tab" onClick={() => setRange(r)}>
                  {r}
                </button>
              ))}
            </div>
            {onClose && (
              <button className="g-btn g-btn-ghost g-icon-btn" aria-label="Close" onClick={onClose}>
                ×
              </button>
            )}
          </div>
        </div>
        {error ? <span className="g-meta">{error}</span> : view && view.range === range ? <CompareView view={view} /> : <span className="g-skeleton" style={{ height: H, width: "100%" }} />}
      </div>
    </div>
  );
}
