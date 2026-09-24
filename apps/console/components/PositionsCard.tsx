"use client";
/**
 * The Dashboard's positions, from GET /portfolio: each stock's quantity, average cost, value, PnL ($ and %; lime when
 * up, a muted red when down) and the price's age. Average cost comes from the vault's own trades.
 */
import type { PortfolioView } from "@/lib/api";

const pnlClass = (formatted: string | null | undefined) => (!formatted || formatted === "$0" || formatted === "0%" ? "" : formatted.startsWith("-") ? "pnl-down" : "pnl-up");

export function PositionsTable({ data }: { data: PortfolioView }) {
  const t = data.totals;
  return (
    <div className="positions">
      <table className="table">
        <thead>
          <tr>
            <th>Stock</th>
            <th className="num">Quantity</th>
            <th className="num">Avg cost</th>
            <th className="num">Value</th>
            <th className="num">PnL</th>
            <th className="num">Price age</th>
          </tr>
        </thead>
        <tbody>
          {data.positions.map((p) => (
            <tr key={p.symbol}>
              <td>
                <span className="ticker">{p.symbol}</span> <span className="meta">{p.name}</span>
                {p.transferredIn && <span className="meta block">Includes {p.transferredIn.formatted} sent in, at no cost</span>}
              </td>
              <td className="num mono">{p.qty.formatted}</td>
              <td className="num mono">{p.avgCost.formatted}</td>
              <td className="num mono">{p.value.formatted}</td>
              <td className={`num mono ${pnlClass(p.unrealizedPnl.formatted)}`}>
                {p.unrealizedPnl.formatted}
                {p.unrealizedPnlPct ? ` · ${p.unrealizedPnlPct}` : ""}
              </td>
              <td className="num mono meta">{p.priceAge.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="meta positions-total">
        In stocks <span className="mono">{t.stocksValue.formatted}</span> · paid <span className="mono">{t.costBasis.formatted}</span> ·{" "}
        <span className={`mono ${pnlClass(t.unrealizedPnl.formatted)}`}>
          {t.unrealizedPnl.formatted}
          {t.unrealizedPnlPct ? ` (${t.unrealizedPnlPct})` : ""}
        </span>
        {t.realizedPnl.raw !== "0" && (
          <>
            {" "}
            · realized from sales <span className={`mono ${pnlClass(t.realizedPnl.formatted)}`}>{t.realizedPnl.formatted}</span>
          </>
        )}
      </p>
    </div>
  );
}
