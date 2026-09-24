"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { Address } from "viem";

import { MarketChip } from "@/components/MarketChip";
import { OwnVaultGate } from "@/components/OwnVaultGate";
import { PositionsTable } from "@/components/PositionsCard";
import { GlanceCard } from "@/components/GlanceCard";
import { LinkedBrowsers } from "@/components/LinkedBrowsers";
import { Meter } from "@/components/Meter";
import { Notice } from "@/components/Notice";
import { ProblemNotice } from "@/components/ProblemNotice";
import { Skeleton } from "@/components/Skeleton";
import { WithdrawCard } from "@/components/WithdrawCard";
import type { VaultView } from "@/lib/api";
import { capRows, freesUp, marketNow, type CapRow, type CapState, type CapUse } from "@/lib/caps";
import { addressUrl } from "@/lib/chain";
import { formatDuration, formatUsd, formatWhen, shortAddress } from "@/lib/format";
import { useHref, usePortfolio, useVaultView } from "@/lib/vault";

export default function Dashboard() {
  return <OwnVaultGate>{(vault) => <DashboardFor vault={vault} />}</OwnVaultGate>;
}

function DashboardFor({ vault }: { vault: Address }) {
  const q = useVaultView(vault);
  const href = useHref();
  // Opened from Glance ("Link Glance", "Relink"): the Glance card comes into view, its button ready.
  const focusGlance = useSearchParams().get("glance") === "link";

  return (
    <div className="page">
      <VaultHeading vault={q.data} address={vault} />
      {q.error ? <ProblemNotice error={q.error} what="this vault" /> : null}
      {q.isLoading && !q.data && (
        <div className="grid grid-2">
          <div className="card"><Skeleton lines={3} tall /></div>
          <div className="card"><Skeleton lines={4} /></div>
        </div>
      )}
      {q.data && (
        <>
          <Balances v={q.data} />
          <WithdrawCard
            vault={q.data.address}
            owner={q.data.owner}
            usdg={q.data.usdg.address}
            decimals={q.data.usdg.decimals}
            balance={BigInt(q.data.balances.usdg.raw)}
            usdgLabel={q.data.usdg.real === true ? "Paxos USDG" : q.data.usdg.real === false ? "TestUSDG" : "USDG"}
          />
          <Caps v={q.data} />
          <div className="grid grid-2">
            <Agent v={q.data} limitsHref={href("/limits")} />
            <AgentPromise v={q.data} />
          </div>
          <GlanceCard vault={q.data.address} owner={q.data.owner} focus={focusGlance} />
          <LinkedBrowsers vault={q.data.address} owner={q.data.owner} />
        </>
      )}
    </div>
  );
}

function VaultHeading({ vault, address }: { vault?: VaultView; address: string }) {
  const usdg = vault?.usdg.real === true ? "Paxos USDG" : vault?.usdg.real === false ? "TestUSDG stand-in" : vault ? "USDG" : null;
  return (
    <div className="page-head">
      <div>
        <p className="eyebrow">Your vault</p>
        <h1 className="title">Your vault, and the leash on its agent</h1>
        <p className="meta">
          <a className="mono" href={addressUrl(address)} target="_blank" rel="noreferrer">
            {address} ↗
          </a>
        </p>
      </div>
      {vault && (
        <div className="chips">
          {usdg && <span className={`chip ${vault.usdg.real ? "chip-accent" : ""}`}>{usdg}</span>}
          <span className={`chip ${vault.paused ? "chip-guard" : "chip-accent"}`}>{vault.paused ? "Paused" : "Trading allowed"}</span>
          <span className={`chip ${vault.agentActive ? "" : "chip-guard"}`}>{vault.agent ? (vault.agentActive ? "Agent active" : "Agent expired") : "No agent"}</span>
        </div>
      )}
    </div>
  );
}

function Balances({ v }: { v: VaultView }) {
  const held = v.positions.filter((p) => BigInt(p.quantity.raw) > 0n);
  const portfolio = usePortfolio(v.address);
  const empty = BigInt(v.balances.total.raw) === 0n;
  return (
    <section className="card" aria-labelledby="bal-h">
      <div className="balance-hero">
        <div>
          <p className="eyebrow" id="bal-h">Total value</p>
          <p className="display figure">{v.balances.total.formatted}</p>
          <p className="meta">Stocks valued at the vault's own oracle price, USDG at $1.</p>
        </div>
        <dl className="kv">
          <div><dt>USDG</dt><dd className="figure-sm">{v.balances.usdg.formatted}</dd></div>
          <div><dt>In stocks</dt><dd className="figure-sm">{v.balances.invested.formatted}</dd></div>
        </dl>
      </div>
      {empty ? (
        <Notice title="This vault holds nothing yet">It needs USDG before the agent can buy anything. Fund it from the owner's wallet: Get started walks through it.</Notice>
      ) : held.length === 0 ? (
        <p className="meta pad">No stock positions yet. Everything is in USDG.</p>
      ) : portfolio.data && portfolio.data.positions.length > 0 ? (
        // Average cost, PnL and price age, from the vault's own trades (GET /portfolio).
        <PositionsTable data={portfolio.data} />
      ) : (
        <table className="table">
          <thead>
            <tr><th>Stock</th><th className="num">Quantity</th><th className="num">Value</th><th>Market</th></tr>
          </thead>
          <tbody>
            {held.map((p) => (
              <tr key={p.symbol}>
                <td><span className="ticker">{p.symbol}</span> <span className="meta">{p.name}</span></td>
                <td className="num mono">{p.quantity.formatted}</td>
                <td className="num mono">{p.value.formatted}</td>
                <td><MarketChip state={p.marketState} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Caps({ v }: { v: VaultView }) {
  const rows = capRows(v);
  const now = marketNow(v.positions);
  const d = v.usdg.decimals;
  const inForce: CapState | null = now.state === "OPEN" || now.state === "CLOSED" ? now.state : null;
  return (
    <section className="card" aria-labelledby="caps-h">
      <div className="section-head">
        <div>
          <h2 className="heading" id="caps-h">Caps</h2>
          <p className="meta">Enforced by the vault contract on every trade. While the market's closed, each cap shrinks to {v.limits.weekendCap} of itself.</p>
        </div>
        <InForce now={now} />
      </div>
      <div className="caps">
        {rows.map((r) => (
          <CapCard key={r.kind} row={r} decimals={d} inForce={inForce} />
        ))}
      </div>
      <p className="meta pad-top">
        Slippage: at most {v.limits.maxSlippage} from the oracle price while open, half that while closed. Every trade also needs a fresh price: a stock
        whose price is too old can't be traded at all.
      </p>
    </section>
  );
}

function InForce({ now }: { now: ReturnType<typeof marketNow> }) {
  if (now.state === "OPEN") return <span className="chip chip-accent">Market open: open caps in force</span>;
  if (now.state === "CLOSED") return <span className="chip chip-guard">Market closed: closed caps in force</span>;
  if (now.state === "MIXED")
    return (
      <span className="chip chip-guard">
        Open for {now.open.join(", ")}; closed for {now.closed.join(", ")}
      </span>
    );
  return <span className="chip chip-fail">Prices too old: no trading</span>;
}

function CapCard({ row, decimals, inForce }: { row: CapRow; decimals: number; inForce: CapState | null }) {
  const usd = (x: bigint) => formatUsd(x, decimals);
  const column = (state: CapState, use: CapUse) => {
    return (
      <div className="cap-col" data-active={inForce === state || undefined}>
        <div className="cap-col-head">
          <span className="meta">{state === "OPEN" ? "Market open" : "Market closed"}</span>
          {inForce === state && <span className="tag">In force</span>}
        </div>
        <p className="figure-sm">{usd(use.cap)}</p>
        {row.rolling ? (
          <>
            <Meter usedBps={use.usedBps} tone={use.remaining === 0n ? "guard" : inForce === state ? "accent" : "muted"} label={`${row.label}, ${state.toLowerCase()}: used`} />
            <p className="meta">
              <span className="mono">{usd(use.used)}</span> used · <span className="mono">{usd(use.remaining)}</span> left
            </p>
          </>
        ) : (
          <p className="meta">Each trade up to this, buy or sell.</p>
        )}
      </div>
    );
  };
  return (
    <article className="cap">
      <h3 className="ui">{row.label}</h3>
      <div className="cap-cols">
        {column("OPEN", row.open)}
        {column("CLOSED", row.closed)}
      </div>
      <p className="meta">{row.rolling ? freesUp(row.window, decimals) : "No running total: every trade is checked on its own."}</p>
    </article>
  );
}

function Agent({ v, limitsHref }: { v: VaultView; limitsHref: string }) {
  const expired = v.agent !== null && !v.agentActive;
  return (
    <section className="card" aria-labelledby="agent-h">
      <h2 className="heading" id="agent-h">Agent</h2>
      {v.agent ? (
        <dl className="kv kv-stack">
          <div>
            <dt>Address</dt>
            <dd>
              <a className="mono" href={addressUrl(v.agent)} target="_blank" rel="noreferrer">
                {shortAddress(v.agent)} ↗
              </a>
            </dd>
          </div>
          <div>
            <dt>Permission</dt>
            <dd>
              {expired ? (
                <span className="text-guard">Expired {formatWhen(v.agentExpiry)}</span>
              ) : (
                <>
                  Expires in {formatDuration(v.agentExpiresInSeconds)} <span className="meta">({formatWhen(v.agentExpiry)})</span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Trading</dt>
            <dd>{v.paused ? <span className="text-guard">Paused by the owner</span> : "Allowed"}</dd>
          </div>
        </dl>
      ) : (
        <p className="body">No agent is authorised. Nothing can trade for this vault until the owner adds one.</p>
      )}
      <Link className="btn btn-small" href={limitsHref}>
        Pause, revoke or change limits
      </Link>
    </section>
  );
}

function AgentPromise({ v }: { v: VaultView }) {
  return (
    <section className="card promise" aria-labelledby="promise-h">
      <h2 className="heading" id="promise-h">What the agent can and can't do</h2>
      <div className="promise-cols">
        <div>
          <p className="eyebrow text-accent">Can</p>
          <ul className="list">
            <li>Buy and sell the five approved stocks, only through the approved desk.</li>
            <li>At a price no worse than the oracle's, minus {v.limits.maxSlippage} slippage.</li>
            <li>Up to {v.limits.perTrade.formatted} a trade, {v.limits.dailyBuy.formatted} of buys and {v.limits.dailySell.formatted} of sells in any 24 hours, and {v.limits.weekendCap} of that while the market's closed.</li>
            <li>Only until its permission expires, and never while paused.</li>
          </ul>
        </div>
        <div>
          <p className="eyebrow text-guard">Can't</p>
          <ul className="list">
            <li>Withdraw anything or send money anywhere. Every trade pays back into this vault.</li>
            <li>Change a limit, approve a stock or a venue, unpause, or extend its own permission.</li>
          </ul>
        </div>
      </div>
      <p className="meta">
        Glance's API holds the agent key on a server, so it's treated as if it could be stolen. These limits are what bound it, and the vault contract
        enforces them, not Glance. Only the owner's wallet can change them.
      </p>
    </section>
  );
}
