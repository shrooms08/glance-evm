/**
 * The full price chart, in the side panel (at the top of a stock's view) and in the floating panel: the current price
 * and the change over the range, 1D / 1W / 1M, the chart (Lightweight Charts, loaded on first use: lib/chartLoader.ts),
 * the current vault's buys, sells and cached news as markers, and where the prices come from. Empty or failed: "No
 * chart data yet.", never a broken canvas.
 */
import { CHART_NOTE, CHART_RANGES, NO_CHART_DATA, rangeChange, type ChartData, type ChartRange } from "@glance/core/chart";
import type { ChartHandle } from "@glance/core/chart-mount";
import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { chartAnnotations } from "../lib/chartAnnotations";
import type { Mount } from "../lib/chartLoader";
import { isAddress } from "../lib/settings";
import { useGlance } from "./context";

type Load = { state: "loading" } | { state: "done"; data: ChartData } | { state: "empty" };

export interface StockChartProps {
  symbol: string;
  /** The range to open on (Show me picks the one that fits the question). */
  initialRange?: ChartRange;
  onClose?(): void;
  /** How the chart library is loaded: lazily, differently on the page and in the side panel (lib/chartLoader.ts). */
  mount: Mount;
}

export default function StockChart({ symbol, onClose, mount, initialRange = "1D" }: StockChartProps) {
  const g = useGlance();
  const stock = g.catalog.find((s) => s.symbol === symbol);
  const [range, setRange] = useState<ChartRange>(initialRange);
  // Show me asks which chart is open; a new range clears its drawings (they were drawn for the old one).
  useEffect(() => {
    chartAnnotations.showing = { symbol, range };
    return () => {
      if (chartAnnotations.showing?.symbol === symbol) chartAnnotations.showing = null;
    };
  }, [symbol, range]);
  const firstRange = useRef(range);
  useEffect(() => {
    if (range !== firstRange.current) chartAnnotations.clear(symbol);
    firstRange.current = range;
  }, [range, symbol]);
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
        <ChartCanvas data={data} mount={mount} symbol={symbol} />
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
function ChartCanvas({ data, mount, symbol }: { data: ChartData; mount: Mount; symbol: string }) {
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<ChartHandle | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  // Show me's drawings for this stock: applied once the chart is drawn (waiting ones too), cleared on request.
  useEffect(() => {
    if (!ready) return;
    return chartAnnotations.subscribe(symbol, (change) => {
      if ("clear" in change) handle.current?.clearAnnotations();
      else handle.current?.annotate(change.add);
    });
  }, [ready, symbol]);

  useEffect(() => {
    if (handle.current) {
      handle.current.update(data);
      return;
    }
    let cancelled = false;
    void mount(box.current!, data, { theme: "dark" }).then(
      (h) => {
        if (cancelled) h.destroy();
        else {
          handle.current = h;
          setReady(true);
        }
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
