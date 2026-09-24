"use client";
/**
 * A stock's full price chart on the Prices page (public: no wallet needed). Markers for the connected wallet's vault
 * appear only when there is one. The chart library (Lightweight Charts, via @glance/core/chart-mount) is loaded the
 * first time a chart is opened, never with the page. Empty or failed: "No chart data yet.", never a broken canvas.
 */
import { CHART_NOTE, CHART_RANGES, NO_CHART_DATA, rangeChange, type ChartData, type ChartRange } from "@glance/core/chart";
import type { ChartHandle, MountOptions } from "@glance/core/chart-mount";
import type { ThemeName } from "@glance/design";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { useSelectedVault } from "@/lib/vault";

export type Mount = (el: HTMLElement, data: ChartData, opts: MountOptions) => Promise<ChartHandle>;

/** Loads the chart library on first use. */
const lazyMount: Mount = (el, data, opts) => import("@glance/core/chart-mount").then((m) => m.mountChart(el, data, opts));

export function PriceChart({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<ChartRange>("1D");
  const vault = useSelectedVault();
  const { theme } = useTheme();
  const q = useQuery({ queryKey: ["chart", symbol, range, vault], queryFn: () => api.chart(symbol, range, vault), retry: 1, refetchInterval: 60_000 });
  return <PriceChartView symbol={symbol} range={range} onRange={setRange} theme={theme} loading={q.isLoading} data={q.data ?? null} />;
}

export interface PriceChartViewProps {
  symbol: string;
  range: ChartRange;
  onRange(r: ChartRange): void;
  theme: ThemeName;
  loading: boolean;
  /** Null: failed or not loaded. */
  data: ChartData | null;
  mount?: Mount;
}

export function PriceChartView({ symbol, range, onRange, theme, loading, data, mount = lazyMount }: PriceChartViewProps) {
  const has = data !== null && data.points.length > 0;
  const last = has ? data.points.at(-1) : undefined;
  const change = has ? rangeChange(data.points) : null;
  return (
    <section className="chart" aria-label={`${symbol} price chart`}>
      <div className="between chart-head">
        <div className="chart-price">
          <span className="figure-sm">{last?.formatted ?? "–"}</span>
          <span className={`mono meta ${change && !change.flat ? (change.up ? "pnl-up" : "pnl-down") : ""}`} data-testid="chart-change">
            {change ? `${change.text} · ${range}` : " "}
          </span>
        </div>
        <div className="segmented" role="tablist" aria-label="Chart range">
          {CHART_RANGES.map((r) => (
            <button key={r} role="tab" className="segment" aria-selected={r === range} onClick={() => onRange(r)}>
              {r}
            </button>
          ))}
        </div>
      </div>
      {loading && !data ? (
        <div className="chart-box skeleton" aria-busy="true">
          <span style={{ height: "100%", width: "100%" }} />
        </div>
      ) : has ? (
        // A new canvas per theme: the chart's colors are set when it's created.
        <ChartCanvas key={theme} data={data} theme={theme} mount={mount} />
      ) : (
        <output className="chart-box chart-empty">
          <span className="meta">{NO_CHART_DATA}</span>
        </output>
      )}
      {has && (
        <p className="meta chart-note">
          {data.source.label === "Chainlink" ? CHART_NOTE : (data.source.note ?? `${data.source.label}: ${data.source.detail}.`)} Source: {data.source.label}, {data.source.detail}.
        </p>
      )}
    </section>
  );
}

function ChartCanvas({ data, theme, mount }: { data: ChartData; theme: ThemeName; mount: Mount }) {
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<ChartHandle | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (handle.current) return void handle.current.update(data);
    let cancelled = false;
    mount(box.current!, data, { theme }).then(
      (h) => (cancelled ? h.destroy() : (handle.current = h)),
      () => setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [data, theme, mount]);

  useEffect(
    () => () => {
      handle.current?.destroy();
      handle.current = null;
    },
    [],
  );

  if (failed) {
    return (
      <output className="chart-box chart-empty">
        <span className="meta">{NO_CHART_DATA}</span>
      </output>
    );
  }
  return <div ref={box} className="chart-box" data-testid="chart-canvas" />;
}
