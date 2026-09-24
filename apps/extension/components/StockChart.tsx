/**
 * The full price chart at the top of a stock's view in the side panel: the current price and the change over the range,
 * 1D / 1W / 1M, the chart (Lightweight Charts, loaded with this component: the side panel imports it lazily, and the
 * page's content script never does), the current vault's buys, sells and cached news as markers, and where the prices
 * come from. Empty or failed: "No chart data yet.", never a broken canvas.
 */
import { CHART_NOTE, CHART_RANGES, NO_CHART_DATA, rangeChange, type ChartData, type ChartRange } from "@glance/core/chart";
import { mountChart, type ChartHandle } from "@glance/core/chart-mount";
import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { isAddress } from "../lib/settings";
import { useGlance } from "./context";

type Load = { state: "loading" } | { state: "done"; data: ChartData } | { state: "empty" };

export interface StockChartProps {
  symbol: string;
  onClose?(): void;
  /** For tests: draws instead of Lightweight Charts. */
  mount?: typeof mountChart;
}

export default function StockChart({ symbol, onClose, mount = mountChart }: StockChartProps) {
  const g = useGlance();
  const stock = g.catalog.find((s) => s.symbol === symbol);
  const [range, setRange] = useState<ChartRange>("1D");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const vault = isAddress(g.vaultAddress) ? g.vaultAddress : undefined;

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    void api.chart(symbol, range, vault).then((res) => {
      if (!live) return;
      setLoad(res.ok && res.data.points.length > 0 ? { state: "done", data: res.data } : { state: "empty" });
    });
    return () => {
      live = false;
    };
  }, [symbol, range, vault]);

  const data = load.state === "done" ? load.data : null;
  const last = data?.points.at(-1);
  const change = data ? rangeChange(data.points) : null;

  return (
    <div className="g-card g-chart-card" role="region" aria-label={`${stock?.name ?? symbol} price chart`}>
      <div className="g-section" style={{ gap: 8 }}>
        <div className="g-between">
          <div className="g-row" style={{ gap: 8, minWidth: 0 }}>
            <span className="g-ui">{stock?.name ?? symbol}</span>
            <span className="g-ticker">{symbol}</span>
          </div>
          {onClose && (
            <button className="g-btn g-btn-ghost g-icon-btn" aria-label="Close" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        <div className="g-between" style={{ alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="g-figure">{last ? last.formatted : "—"}</span>
            <span className={`g-data ${change && !change.flat ? (change.up ? "g-up" : "g-down") : ""}`} data-testid="chart-change">
              {change ? `${change.text} · ${range}` : " "}
            </span>
          </div>
          <div className="g-tabs" role="tablist" aria-label="Chart range">
            {CHART_RANGES.map((r) => (
              <button key={r} role="tab" aria-selected={r === range} className="g-tab" onClick={() => setRange(r)}>
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>
      {load.state === "loading" ? (
        <div className="g-chart-box" aria-busy="true">
          <span className="g-skeleton" style={{ height: "100%", width: "100%" }} />
        </div>
      ) : data ? (
        <ChartCanvas data={data} mount={mount} />
      ) : (
        <div className="g-chart-box g-chart-empty" role="status">
          <span className="g-meta">{NO_CHART_DATA}</span>
        </div>
      )}
      <div className="g-section" style={{ gap: 2, paddingTop: 6 }}>
        {data && (
          <>
            <span className="g-meta">{data.source.label === "Chainlink" ? CHART_NOTE : (data.source.note ?? `${data.source.label}: ${data.source.detail}.`)}</span>
            <span className="g-meta">
              Source: {data.source.label} · {data.source.detail}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** The canvas: mounted once, then updated in place when the data changes (range switches keep the same chart). */
function ChartCanvas({ data, mount }: { data: ChartData; mount: typeof mountChart }) {
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<ChartHandle | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (handle.current) {
      handle.current.update(data);
      return;
    }
    let cancelled = false;
    void mount(box.current!, data, { theme: "dark" }).then(
      (h) => {
        if (cancelled) h.destroy();
        else handle.current = h;
      },
      () => setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [data, mount]);

  useEffect(
    () => () => {
      handle.current?.destroy();
      handle.current = null;
    },
    [],
  );

  if (failed) {
    return (
      <div className="g-chart-box g-chart-empty" role="status">
        <span className="g-meta">{NO_CHART_DATA}</span>
      </div>
    );
  }
  return <div ref={box} className="g-chart-box" data-testid="chart-canvas" />;
}
