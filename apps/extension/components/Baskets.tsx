/**
 * The Baskets view: Glance's built-in baskets and your own (kept in this browser), each with its stocks and weights.
 * Make, rename, re-weight and delete your own; buy any of them. A basket buy is one confirm card listing every leg
 * (amount, price, and whether it passes the vault's guards, or why not), the total, and the day's limit left after it.
 */
import { useCallback, useEffect, useState } from "react";
import { basketProblems, equalWeights, FULL_WEIGHT, MAX_LEGS, type Basket } from "@glance/core/basket";

import { allowedSymbols, deleteBasket, describeLegs, listBaskets, newBasketId, percent, saveBasket } from "../lib/baskets";
import { priceUsd, shortHash } from "../lib/format";
import type { PageContext } from "../lib/journal";
import { FailedNotice } from "./CompanyCard";
import { useGlance } from "./context";
import { Orb } from "./Orb";
import { useBasketFlow, type BasketFlow } from "./useBasketFlow";

type View = { view: "list" } | { view: "edit"; draft: Basket; isNew: boolean } | { view: "buy"; basket: Basket };

export function BasketsCard({
  initialBuy,
  notice,
  onClose,
  pageContext,
}: {
  /** Open straight on a buy ("buy $30 of the tech basket"). */
  initialBuy?: { basketId: string; amount: string };
  /** A line to show at the top ("Saved EV: Tesla 50%, AMD 50%."). */
  notice?: string;
  onClose?(): void;
  pageContext?(): Promise<PageContext | null> | PageContext | null;
}) {
  const g = useGlance();
  const [baskets, setBaskets] = useState<Basket[] | null>(null);
  const [view, setView] = useState<View>({ view: "list" });
  const [error, setError] = useState<string | null>(null);
  const flow = useBasketFlow({ pageContext });
  const allowed = allowedSymbols(g.vault, g.catalog);

  const known = g.catalog.map((s) => s.symbol).join(",");
  const reload = useCallback(async () => setBaskets(await listBaskets(known ? known.split(",") : undefined)), [known]);
  useEffect(() => {
    void reload();
  }, [reload]);

  // "buy $30 of the tech basket": straight to the confirm card, once.
  const [autoBuy, setAutoBuy] = useState(initialBuy);
  const { start } = flow;
  useEffect(() => {
    if (!autoBuy || !baskets) return;
    const b = baskets.find((x) => x.id === autoBuy.basketId);
    setAutoBuy(undefined);
    if (!b) return;
    setView({ view: "buy", basket: b });
    void start(b, autoBuy.amount);
  }, [autoBuy, baskets, start]);

  return (
    <div className="g-card" role="region" aria-label="Baskets">
      <div className="g-section" style={{ gap: 10 }}>
        <div className="g-between">
          <span className="g-ui">Baskets</span>
          {onClose && (
            <button className="g-btn g-btn-ghost g-icon-btn" aria-label="Close" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        {notice && view.view === "list" && <span className="g-meta" role="status">{notice}</span>}

        {view.view === "list" && (
          <>
            {baskets === null ? (
              <span className="g-skeleton" style={{ width: "70%" }} />
            ) : (
              <ul className="g-positions">
                {baskets.map((b) => (
                  <li key={b.id} className="g-position" data-basket={b.id}>
                    <div className="g-between">
                      <span className="g-ui">{b.name}</span>
                      {b.builtIn && <span className="g-meta">Glance's</span>}
                    </div>
                    <span className="g-meta">{describeLegs(b.legs)}</span>
                    <div className="g-row" style={{ flexWrap: "wrap" }}>
                      <button className="g-btn" onClick={() => (flow.reset(), setView({ view: "buy", basket: b }))}>
                        Buy
                      </button>
                      {!b.builtIn && (
                        <>
                          <button className="g-link-btn" onClick={() => setView({ view: "edit", draft: structuredClone(b), isNew: false })}>
                            Edit
                          </button>
                          <button
                            className="g-link-btn"
                            aria-label={`Delete ${b.name}`}
                            onClick={async () => {
                              await deleteBasket(b.id);
                              await reload();
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <button className="g-btn g-btn-ghost" onClick={() => setView({ view: "edit", draft: { id: newBasketId(), name: "", legs: equalWeights(allowed.slice(0, 2)) }, isNew: true })}>
              New basket
            </button>
            <span className="g-meta">A basket is sold one stock at a time: say or type “sell all my Tesla”.</span>
          </>
        )}

        {view.view === "edit" && (
          <BasketEditor
            draft={view.draft}
            isNew={view.isNew}
            allowed={allowed}
            error={error}
            onCancel={() => (setError(null), setView({ view: "list" }))}
            onSave={async (b) => {
              try {
                await saveBasket(b, allowed);
                setError(null);
                await reload();
                setView({ view: "list" });
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        )}

        {view.view === "buy" && <BasketBuy basket={view.basket} flow={flow} onBack={() => (flow.reset(), setView({ view: "list" }))} />}
      </div>
    </div>
  );
}

function BasketEditor({ draft, isNew, allowed, error, onSave, onCancel }: { draft: Basket; isNew: boolean; allowed: string[]; error: string | null; onSave(b: Basket): void; onCancel(): void }) {
  const [b, setB] = useState(draft);
  const problems = basketProblems(b, allowed);
  const sum = b.legs.reduce((s, l) => s + l.weightBps, 0);
  const unused = allowed.filter((s) => !b.legs.some((l) => l.symbol === s));
  const setLeg = (i: number, patch: Partial<Basket["legs"][number]>) => setB({ ...b, legs: b.legs.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  return (
    <form
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(b);
      }}
    >
      <label className="g-meta" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Name
        <input className="g-input" aria-label="Basket name" value={b.name} maxLength={40} onChange={(e) => setB({ ...b, name: e.target.value })} autoFocus={isNew} />
      </label>
      {b.legs.map((l, i) => (
        <div key={i} className="g-row">
          <select className="g-input g-grow" aria-label={`Stock ${i + 1}`} value={l.symbol} onChange={(e) => setLeg(i, { symbol: e.target.value })}>
            {[l.symbol, ...unused].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <label className="g-amount" style={{ width: 90 }}>
            <input
              className="g-input"
              inputMode="decimal"
              aria-label={`${l.symbol} weight in percent`}
              value={String(l.weightBps / 100)}
              onChange={(e) => setLeg(i, { weightBps: Math.round(Number(e.target.value.replace(/[^\d.]/g, "") || "0") * 100) })}
            />
            <span>%</span>
          </label>
          <button type="button" className="g-btn g-btn-ghost g-icon-btn" aria-label={`Remove ${l.symbol}`} onClick={() => setB({ ...b, legs: b.legs.filter((_, j) => j !== i) })}>
            ×
          </button>
        </div>
      ))}
      <div className="g-row" style={{ flexWrap: "wrap" }}>
        <button type="button" className="g-link-btn" disabled={unused.length === 0 || b.legs.length >= MAX_LEGS} onClick={() => setB({ ...b, legs: [...b.legs, { symbol: unused[0]!, weightBps: 0 }] })}>
          Add a stock
        </button>
        <button type="button" className="g-link-btn" disabled={b.legs.length === 0} onClick={() => setB({ ...b, legs: equalWeights(b.legs.map((l) => l.symbol)) })}>
          Split equally
        </button>
        <span className={`g-data ${sum === FULL_WEIGHT ? "" : "g-down"}`}>Total {percent(sum)}</span>
      </div>
      {(error || problems[0]) && <span className="g-meta" role="alert">{error ?? problems[0]}</span>}
      <div className="g-row">
        <button className="g-btn g-btn-primary g-grow" type="submit" disabled={problems.length > 0}>
          {isNew ? "Save basket" : "Save changes"}
        </button>
        <button type="button" className="g-btn g-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const STATUS_LABEL: Record<string, string> = { waiting: "Waiting", sending: "Sending…", done: "Bought", reverted: "Refused on chain", "not-sent": "Not sent" };

function BasketBuy({ basket, flow: f, onBack }: { basket: Basket; flow: ReturnType<typeof useBasketFlow>; onBack(): void }) {
  const g = useGlance();
  const [amount, setAmount] = useState("");
  const { flow } = f;

  if (flow.step === "idle") {
    return (
      <form
        className="g-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (amount) void f.start(basket, amount);
        }}
      >
        <label className="g-amount g-grow">
          <span>$</span>
          <input className="g-input" inputMode="decimal" placeholder="Total" aria-label={`Dollars of ${basket.name}`} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} autoFocus />
        </label>
        <button className="g-btn g-btn-primary" type="submit" disabled={!amount}>
          Check {basket.name}
        </button>
        <button type="button" className="g-btn g-btn-ghost" onClick={onBack}>
          Back
        </button>
      </form>
    );
  }
  if (flow.step === "quoting") {
    return (
      <div className="g-row" aria-live="polite">
        <Orb state="thinking" size={28} markUrl={g.markUrl} />
        <span className="g-meta">
          Checking {flow.plan.length} stocks for ${flow.total} against your vault's limits…
        </span>
      </div>
    );
  }
  if (flow.step === "failed") {
    return (
      <>
        <FailedNotice code={flow.code} message={flow.message} onRetry={() => void f.start(flow.basket, flow.total)} />
        <button className="g-btn g-btn-ghost" onClick={onBack}>
          Back to baskets
        </button>
      </>
    );
  }
  if (flow.step === "review") return <Review flow={flow} onConfirm={() => void f.confirm()} onCancel={onBack} />;
  return <Progress flow={flow} onDone={onBack} />;
}

function Review({ flow, onConfirm, onCancel }: { flow: Extract<BasketFlow, { step: "review" }>; onConfirm(): void; onCancel(): void }) {
  const { report } = flow;
  const failing = report.legs.length - report.passing;
  const sendTotal = report.legs.filter((l) => l.ok).reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0) / 100;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-basket-review>
      <ul className="g-positions">
        {report.legs.map((l) => (
          <li key={l.symbol} className="g-position" data-leg={l.symbol} data-ok={l.ok}>
            <div className="g-between">
              <span className="g-ui">
                <span className="g-ticker">{l.symbol}</span> ${l.amount}
              </span>
              <span className="g-data">{l.price ? priceUsd(l.price) : "no price"}</span>
            </div>
            {l.ok ? (
              <span className="g-live g-data">
                <span className="g-dot" /> Passes every vault guard
              </span>
            ) : (
              <span className="g-meta g-down">{l.reason}</span>
            )}
          </li>
        ))}
      </ul>
      <dl className="g-facts">
        <dt>Total</dt>
        <dd>${failing ? sendTotal.toFixed(2) : flow.total}</dd>
        <dt>Left today after</dt>
        <dd>{report.capLeftAfter}</dd>
      </dl>
      {failing > 0 && report.passing > 0 && <span className="g-meta">The {failing === 1 ? "one that fails" : `${failing} that fail`} won't be sent.</span>}
      <div className="g-row">
        {report.passing > 0 && (
          <button className="g-btn g-btn-primary g-grow" onClick={onConfirm} autoFocus>
            {failing ? `Buy the other ${report.passing}` : `Confirm $${flow.total} of ${flow.basket.name}`}
          </button>
        )}
        <button className="g-btn g-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Progress({ flow, onDone }: { flow: Extract<BasketFlow, { step: "sending" | "finished" }>; onDone(): void }) {
  const finished = flow.step === "finished";
  const done = flow.legs.filter((l) => l.status === "done").length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-live="polite" data-basket-progress={flow.step}>
      {finished && (
        <span className="g-ui">
          {done === flow.legs.length ? `Bought ${flow.basket.name}: all ${done} stocks.` : `${done} of ${flow.legs.length} went through. The basket stopped there.`}
        </span>
      )}
      <ul className="g-positions">
        {flow.legs.map((l) => (
          <li key={l.symbol} className="g-position" data-leg={l.symbol} data-status={l.status}>
            <div className="g-between">
              <span className="g-ui">
                <span className="g-ticker">{l.symbol}</span> ${l.amount}
              </span>
              <span className={`g-data ${l.status === "reverted" || l.status === "not-sent" ? "g-down" : ""}`}>{l.status === "done" && l.got ? l.got : STATUS_LABEL[l.status]}</span>
            </div>
            {l.reason && <span className="g-meta">{l.reason}</span>}
            {l.txHash && l.explorerUrl && (
              <a className="g-data" href={l.explorerUrl} target="_blank" rel="noopener noreferrer">
                tx {shortHash(l.txHash)} ↗
              </a>
            )}
          </li>
        ))}
      </ul>
      {finished && flow.message && <span className="g-meta">{flow.message}</span>}
      {finished && (
        <button className="g-btn g-btn-ghost" onClick={onDone}>
          Back to baskets
        </button>
      )}
    </div>
  );
}
