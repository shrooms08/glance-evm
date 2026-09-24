/**
 * "Why it moved": a company's recent move and the news behind it, from GET /why/:symbol. The summary only restates the
 * headlines it cites ([1], [2], each a link to its source), and never advises. Loaded only when asked for: a click on
 * the line in the company card, or a question ("why did Tesla move?"). Never on hover.
 */
import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api";
import type { WhyMoved } from "../lib/api-types";

type Load = { state: "idle" } | { state: "loading" } | { state: "done"; data: WhyMoved } | { state: "failed"; message: string };

function useWhy(symbol: string, initial?: WhyMoved) {
  const [load, setLoad] = useState<Load>(initial ? { state: "done", data: initial } : { state: "idle" });
  const fetchWhy = useCallback(async () => {
    setLoad({ state: "loading" });
    const res = await api.why(symbol);
    setLoad(res.ok ? { state: "done", data: res.data } : { state: "failed", message: res.message });
  }, [symbol]);
  return { load, fetchWhy };
}

/** The line in a company card: nothing is fetched until it's clicked. */
export function WhyLine({ symbol }: { symbol: string }) {
  const { load, fetchWhy } = useWhy(symbol);
  if (load.state === "idle") {
    return (
      <button className="g-link-btn g-why-open" onClick={() => void fetchWhy()}>
        Why it moved
      </button>
    );
  }
  return <WhyBody load={load} onRetry={() => void fetchWhy()} />;
}

/** The panel card for "why did Tesla move?" (voice or typed). */
export function WhyCard({ symbol, name, onClose }: { symbol: string; name?: string; onClose?(): void }) {
  const { load, fetchWhy } = useWhy(symbol);
  useEffect(() => {
    void fetchWhy();
  }, [fetchWhy]);
  return (
    <div className="g-card" role="region" aria-label={`Why ${name ?? symbol} moved`}>
      <div className="g-section" style={{ gap: 8 }}>
        <div className="g-between">
          <span className="g-ui">Why {name ?? symbol} moved</span>
          {onClose && (
            <button className="g-btn g-btn-ghost g-icon-btn" aria-label="Close" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        <WhyBody load={load} onRetry={() => void fetchWhy()} />
      </div>
    </div>
  );
}

function WhyBody({ load, onRetry }: { load: Load; onRetry(): void }) {
  if (load.state === "loading" || load.state === "idle") {
    return (
      <div className="g-why" aria-busy="true">
        <span className="g-skeleton" style={{ width: "90%" }} />
        <span className="g-skeleton" style={{ width: "70%" }} />
      </div>
    );
  }
  if (load.state === "failed") {
    return (
      <div className="g-why">
        <span className="g-meta">{load.message}</span>
        <button className="g-link-btn" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  return <WhyDetails data={load.data} />;
}

/** The move, the summary with its citations as links, and the sources. */
export function WhyDetails({ data }: { data: WhyMoved }) {
  const m = data.move;
  return (
    <div className="g-why">
      {m?.pct && (
        <span className="g-data">
          <span className={m.pct.startsWith("-") ? "g-down" : m.pct === "0%" ? "" : "g-up"}>{m.pct}</span> {m.window} ({m.from} to {m.to}) · {m.label}
        </span>
      )}
      {m?.note && <span className="g-meta">{m.note}</span>}
      {data.summary ? (
        <p className="g-body g-why-summary">
          <Cited text={data.summary} sources={data.sources} />
        </p>
      ) : data.sources.length > 0 ? (
        <span className="g-meta">The latest headlines:</span>
      ) : null}
      {data.sources.length > 0 && (
        <ol className="g-sources">
          {data.sources.map((s, i) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.title}
              </a>
              <span className="g-meta">
                {" "}
                [{i + 1}] {s.site}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** "... beat estimates [1]" with [1] linked to its source. */
function Cited({ text, sources }: { text: string; sources: WhyMoved["sources"] }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const n = /^\[(\d+)\]$/.exec(p);
        const src = n ? sources[Number(n[1]) - 1] : undefined;
        if (!n) return <span key={i}>{p}</span>;
        return src ? (
          <a key={i} className="g-cite" href={src.url} target="_blank" rel="noopener noreferrer" title={`${src.title} (${src.site})`}>
            [{n[1]}]
          </a>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </>
  );
}

/** The summary as spoken: citation marks removed. */
export function spokenWhy(data: WhyMoved, name: string): string {
  if (data.summary) return data.summary.replace(/\s*\[\d+\]/g, "").replace(/\s+([.,])/g, "$1").trim();
  if (data.sources.length) return `Here are the latest headlines about ${name}.`;
  return "News isn't available right now.";
}
