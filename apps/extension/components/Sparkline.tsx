/**
 * The hover card's 1D sparkline: plain SVG (no chart library in the page's bundle), stepped like the full chart, no
 * axes. Loaded only when the card opens, and kept per symbol for 60 seconds.
 */
import { rangeChange, sparklinePath, type ChartData } from "@glance/core/chart";
import { useEffect, useState } from "react";

import { api } from "../lib/api";

export const SPARKLINE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; data: ChartData }>();

/** For tests. */
export function clearSparklineCache() {
  cache.clear();
}

export async function sparklineData(symbol: string, now = Date.now()): Promise<ChartData | null> {
  const hit = cache.get(symbol);
  if (hit && now - hit.at < SPARKLINE_TTL_MS) return hit.data;
  const res = await api.chart(symbol, "1D");
  if (!res.ok) return null;
  cache.set(symbol, { at: now, data: res.data });
  return res.data;
}

const W = 240;
const H = 36;

export function Sparkline({ symbol }: { symbol: string }) {
  const [data, setData] = useState<ChartData | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void sparklineData(symbol).then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [symbol]);

  if (data === undefined) return <span className="g-skeleton" style={{ height: H, width: "100%" }} aria-hidden />;
  const d = data ? sparklinePath(data.points, W, H) : "";
  if (!d) return null; // nothing to draw: the card doesn't show an empty box
  const change = rangeChange(data!.points);
  return (
    <svg
      className={`g-spark ${change && !change.flat && !change.up ? "g-down" : "g-up"}`}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${symbol} over the last day${change ? `: ${change.text}` : ""}`}
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
