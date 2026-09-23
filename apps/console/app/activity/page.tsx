"use client";
import { useMemo, useState } from "react";

import { Notice } from "@/components/Notice";
import { ProblemNotice } from "@/components/ProblemNotice";
import { Skeleton } from "@/components/Skeleton";
import type { ActivityItem, ActivityView } from "@/lib/api";
import { dayLabel, formatWhen, shortAddress } from "@/lib/format";
import { foldOwnerRuns } from "@/lib/activity";
import { guardCounts } from "@/lib/guards";
import { useActivity, useSelectedVault } from "@/lib/vault";

type Filter = "all" | "trade" | "refusal" | "owner";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "Everything" },
  { key: "trade", label: "Trades" },
  { key: "refusal", label: "Refusals" },
  { key: "owner", label: "Owner changes" },
];

export default function ActivityPage() {
  const vault = useSelectedVault();
  const q = useActivity(vault);
  const [filter, setFilter] = useState<Filter>("all");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Activity</p>
          <h1 className="title">Every trade, and every time the guards said no</h1>
          <p className="meta">Newest first. Trades and owner changes come from the vault's own events; refusals sit right beside them.</p>
        </div>
      </div>

      {q.error ? <ProblemNotice error={q.error} what="the activity" /> : null}
      {q.isLoading && !q.data && (
        <div className="card">
          <Skeleton lines={6} />
        </div>
      )}
      {q.data && <Proof data={q.data} filter={filter} setFilter={setFilter} />}
      {q.data && <Timeline items={q.data.items} filter={filter} />}
      {q.data && <Sources data={q.data} />}
    </div>
  );
}

function Proof({ data, filter, setFilter }: { data: ActivityView; filter: Filter; setFilter(f: Filter): void }) {
  const trades = data.items.filter((i) => i.kind === "trade").length;
  const refusals = data.items.filter((i) => i.kind === "refusal");
  const owner = data.items.filter((i) => i.kind === "owner").length;
  const fired = guardCounts(refusals.map((r) => r.refusal?.code ?? "UNKNOWN"));
  return (
    <section className="proof" aria-label="Summary">
      <div className="proof-stats">
        <Stat n={trades} label={trades === 1 ? "trade went through" : "trades went through"} tone="accent" />
        <Stat n={refusals.length} label={refusals.length === 1 ? "refused by a guard" : "refused by the guards"} tone="guard" />
        <Stat n={owner} label={owner === 1 ? "owner change" : "owner changes"} tone="muted" />
      </div>
      {fired.length > 0 && (
        <div className="fired">
          <span className="meta">Guards that fired</span>
          <ul className="chips">
            {fired.map((f) => (
              <li key={f.code} className="chip chip-guard">
                {f.label} <span className="mono">×{f.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="segmented" role="tablist" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.key} role="tab" aria-selected={filter === f.key} className="segment" onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: "accent" | "guard" | "muted" }) {
  return (
    <div className="stat" data-tone={tone}>
      <span className="stat-n figure">{n}</span>
      <span className="meta">{label}</span>
    </div>
  );
}

function Timeline({ items, filter }: { items: ActivityItem[]; filter: Filter }) {
  const now = Math.floor(Date.now() / 1000);
  const shown = items.filter((i) => filter === "all" || i.kind === filter);
  const days = useMemo(() => {
    const groups: Array<{ day: string; items: ActivityItem[] }> = [];
    for (const item of shown) {
      const day = dayLabel(item.timestamp, now);
      const last = groups.at(-1);
      if (last && last.day === day) last.items.push(item);
      else groups.push({ day, items: [item] });
    }
    return groups;
  }, [shown, now]);

  if (items.length === 0) {
    return (
      <Notice title="Nothing has happened in this vault yet">
        When the agent trades, or a guard stops a trade, or the owner changes a setting, it appears here with its transaction.
      </Notice>
    );
  }
  if (shown.length === 0) {
    return <Notice title={filter === "refusal" ? "No refusals yet" : "Nothing of that kind yet"}>{filter === "refusal" ? "Every trade so far stayed inside the limits." : "Try Everything."}</Notice>;
  }
  return (
    <ol className="timeline">
      {days.map((g) => (
        <li key={g.day} className="day">
          <h2 className="day-label eyebrow">{g.day}</h2>
          <ol className="events">
            {foldOwnerRuns(g.items).map((entry) =>
              Array.isArray(entry) ? (
                <OwnerRun key={`run-${entry[0]!.txHash}-${entry.length}`} items={entry} />
              ) : (
                <Event key={itemKey(entry)} item={entry} />
              ),
            )}
          </ol>
        </li>
      ))}
    </ol>
  );
}

const itemKey = (i: ActivityItem) => `${i.type}-${i.txHash ?? ""}-${i.logIndex ?? ""}-${i.timestamp}-${i.summary}`;

function OwnerRun({ items }: { items: ActivityItem[] }) {
  const first = items[items.length - 1]!;
  const last = items[0]!;
  return (
    <li className="event" data-kind="owner">
      <span className="node" aria-hidden />
      <details className="event-body fold">
        <summary>
          <div className="fold-summary">
            <p className="event-title">{items.length} owner changes</p>
            <span className="meta mono">
              {formatWhen(first.timestamp)}
              {first.timestamp !== last.timestamp ? ` – ${formatWhen(last.timestamp)}` : ""}
            </span>
          </div>
          <div className="event-meta">
            <span className="chip">Owner</span>
            <span className="fold-hint">Show each, with its transaction</span>
          </div>
        </summary>
        <ul className="fold-items">
          {items.map((i) => (
            <li key={itemKey(i)} className="fold-item">
              <span>{i.summary}</span>
              {i.explorerUrl && i.txHash && (
                <a className="meta mono" href={i.explorerUrl} target="_blank" rel="noreferrer">
                  {shortAddress(i.txHash)} ↗
                </a>
              )}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

function Event({ item }: { item: ActivityItem }) {
  if (item.kind === "refusal" && item.refusal) return <RefusalEvent item={item} />;
  const market = typeof item.data.marketState === "string" ? item.data.marketState : null;
  return (
    <li className="event" data-kind={item.kind}>
      <span className="node" aria-hidden />
      <div className="event-body">
        <div className="event-top">
          <p className="event-title">{item.summary}</p>
          <time className="meta mono" dateTime={new Date(item.timestamp * 1000).toISOString()}>
            {formatWhen(item.timestamp)}
          </time>
        </div>
        <div className="event-meta">
          <span className="chip">{item.kind === "trade" ? "Trade" : "Owner"}</span>
          {market && <span className={`chip ${market === "OPEN" ? "chip-accent" : "chip-guard"}`}>{market === "OPEN" ? "Market open" : "Market closed"}</span>}
          {item.explorerUrl && item.txHash && (
            <a className="meta mono" href={item.explorerUrl} target="_blank" rel="noreferrer">
              {shortAddress(item.txHash)} ↗
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

function RefusalEvent({ item }: { item: ActivityItem }) {
  const r = item.refusal!;
  const onChain = r.source === "onchain";
  return (
    <li className="event" data-kind="refusal">
      <span className="node" aria-hidden />
      <div className="event-body refusal">
        <div className="event-top">
          <p className="event-title">
            <span className="refused-tag">Refused</span> {item.summary}
          </p>
          <time className="meta mono" dateTime={new Date(item.timestamp * 1000).toISOString()}>
            {formatWhen(item.timestamp)}
          </time>
        </div>
        <blockquote className="refusal-quote">“{r.message}”</blockquote>
        <div className="event-meta">
          <span className="chip chip-guard mono">{r.error}</span>
          {onChain ? (
            <>
              <span className="chip">Reverted on chain{r.from ? (r.byAgent ? " · sent by the agent" : ` · sent by ${shortAddress(r.from)}`) : ""}</span>
              {item.explorerUrl && item.txHash && (
                <a className="meta mono" href={item.explorerUrl} target="_blank" rel="noreferrer">
                  {shortAddress(item.txHash)} ↗
                </a>
              )}
            </>
          ) : (
            <span className="chip" title="Glance simulates every trade against the live vault, as the agent, before signing anything.">
              Checked against the vault, never sent{r.via === "trade" ? " · after confirm" : ""}
            </span>
          )}
        </div>
        {!onChain && <p className="meta">No transaction: the vault's own check stopped it before anything was signed, so there's nothing to link to.</p>}
      </div>
    </li>
  );
}

function Sources({ data }: { data: ActivityView }) {
  const s = data.sources;
  return (
    <section className="card sources" aria-labelledby="src-h">
      <h2 className="ui" id="src-h">Where refusals come from</h2>
      <ul className="list meta">
        <li>
          <strong>Checked against the vault, never sent.</strong> Before the agent signs a trade, Glance runs the exact call against the live vault, as the
          agent. If a guard would stop it, nothing is sent. A vault emits no event for a trade it refuses, so the Glance API records these itself
          {s && !s.preflightRefusals.persisted ? " (in memory on this API, so only since it last started)" : ""}.
        </li>
        <li>
          <strong>Reverted on chain.</strong> Transactions that reached the vault and were refused by it, read from the explorer: they have a transaction
          link, and the reason is decoded from the vault's own error.
        </li>
      </ul>
      {s?.onChainRefusals === "unavailable" && (
        <Notice tone="guard" title="The explorer isn't answering, so reverted transactions aren't listed right now">
          Trades, owner changes and checked refusals are complete. The console keeps checking.
        </Notice>
      )}
    </section>
  );
}
