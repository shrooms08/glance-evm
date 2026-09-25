"use client";
/**
 * Step 4 of Get started, without any wallet wiring (so each state can be tested directly):
 *   not funded   the first deposit amount and "Create my vault" / "Finish setup"
 *   funded       a success state (what the vault holds, the deposit's transaction), "Finish setup" only if some
 *                configuration is still missing (it never deposits again), and a separate "Add more USDG" input
 * The buttons are disabled from the first click until the transaction settles.
 */
import Link from "next/link";
import type { Address } from "viem";

import { addressUrl, txUrl } from "@/lib/chain";
import { etfs, stocks, type DemoVault } from "@/lib/deployment";
import { symbolList } from "@/lib/symbolList";
import { formatUsd, shortAddress } from "@/lib/format";
import type { SetupPlan } from "@/lib/setup";
import type { StepStatus, VaultProgress } from "@/lib/setupStatus";
import { errorAction, type ErrorActionKind } from "@/lib/errorAction";

import { Notice } from "./Notice";

export interface VaultStepProps {
  status: StepStatus;
  progress: VaultProgress;
  /** Finish setup's plan (configuration, and the first deposit only while unfunded). */
  plan: SetupPlan | null;
  /** Connected, on the right network, and the chain reads are in. */
  ready: boolean;
  /** A transaction is waiting for the wallet or confirming (or a run is between steps). */
  busy: boolean;
  flavour: DemoVault;
  flavours: DemoVault[];
  /**
   * Offer the Paxos USDG / TestUSDG choice. Only with ?dev=1 (the TestUSDG fallback, should the Paxos faucet ever go
   * down) and only before the wallet has a vault. Everyone else gets Paxos USDG.
   */
  showFlavourChoice: boolean;
  onFlavour(key: DemoVault["key"]): void;
  vault: Address | null;
  vaultHref?: string;
  vaultBalance: bigint;
  decimals: number;
  depositHash: string | null;
  deposit: { value: string; error: string | null; onChange(v: string): void };
  addMore: { value: string; error: string | null; plan: SetupPlan | null; onChange(v: string): void; onSubmit(): void };
  onFinish(): void;
  runError: string | null;
  /** Glance is in this browser and not linked yet: "Create my vault" goes straight on to linking (one signature). */
  linkAfter?: boolean;
  /** The one way on from an error (Get gas, Get USDG, Switch network, Try again). */
  onErrorAction?(kind: ErrorActionKind): void;
}

/** Exactly one action for an error, chosen from its own words. */
export function ErrorActionButton({ message, code, onAction }: { message: string; code?: string; onAction?(kind: ErrorActionKind): void }) {
  if (!onAction) return null;
  const a = errorAction(message, code);
  return (
    <button className="btn btn-primary btn-small" onClick={() => onAction(a.kind)}>
      {a.label}
    </button>
  );
}

/**
 * The wallet prompts a run will ask for, named: "3 wallet prompts: approve, create, sign" (the last is the signature
 * that links Glance, when it follows), "2 wallet prompts: create, sign" when the allowance already covers the deposit.
 */
export function promptPlan(labels: string[], linkAfter: boolean): string {
  const names: string[] = labels.map((l) => (/^Approve/.test(l) ? "approve" : /^Create/.test(l) ? "create" : /^Take/.test(l) ? "faucet" : /^Deposit|^Let the vault/.test(l) ? "deposit" : "confirm"));
  if (linkAfter) names.push("sign");
  const n = names.length;
  return `${n} wallet prompt${n === 1 ? "" : "s"}${linkAfter ? `: ${names.join(", ")}` : ""}`;
}

export function VaultStep(p: VaultStepProps) {
  const done = p.status === "done";
  const funded = p.progress.funded;
  const steps = p.plan?.steps ?? [];
  const oneTx = p.plan?.mode === "one-tx" && !p.vault;
  const showFinish = steps.length > 0 && !p.plan?.blocked;
  const finishLabel = p.busy ? "Working…" : p.vault ? "Finish setup" : "Create my vault";
  // With Glance in this browser (and not yet linked), creating the vault goes straight on to linking: one signature more.
  const prompts = promptPlan(steps.map((s) => s.label), Boolean(p.linkAfter));

  return (
    <div className="create">
      {oneTx ? (
        <p className="meta">
          One transaction creates your vault, already set up: {symbolList([...stocks, ...etfs].map((s) => s.symbol))} with their price checks, the Glance agent for 30 days, and limits of $100 a
          trade and $500 a day each way (a quarter of that while the market is closed). Your deposit goes in with it. You&apos;re the owner from the start,
          and nobody else can move your money. Change any limit later under Limits.
        </p>
      ) : (
        <p className="meta">
          Sets up your vault one wallet prompt at a time: {symbolList(stocks.map((s) => s.symbol))} with their price checks{etfs.length ? ` (${symbolList(etfs.map((e) => e.symbol))} can be added later under Limits)` : ""}, the Glance agent for 29 days, then your first
          deposit. It starts with limits of $100 a trade and $500 a day each way (a quarter of that while the market is closed). You&apos;re the owner,
          and nobody else can move your money. Change any limit later under Limits.
        </p>
      )}

      {p.showFlavourChoice && !funded && (
        <fieldset className="segmented" aria-label="Which USDG" disabled={p.busy}>
          {p.flavours.map((d) => (
            <label key={d.key} className="segment">
              <input className="sr" type="radio" name="usdg" checked={p.flavour.key === d.key} onChange={() => p.onFlavour(d.key)} />
              {d.usdgLabel}
              {d.primary ? " (recommended)" : ""}
            </label>
          ))}
        </fieldset>
      )}

      {p.vault && (
        <p className="meta">
          Your vault:{" "}
          {p.vaultHref ? (
            <Link className="mono" href={p.vaultHref}>
              {shortAddress(p.vault)}
            </Link>
          ) : (
            <span className="mono">{shortAddress(p.vault)}</span>
          )}{" "}
          on {p.flavour.usdgLabel} ·{" "}
          <a className="mono" href={addressUrl(p.vault)} target="_blank" rel="noreferrer">
            explorer ↗
          </a>
          {" · "}
          {p.progress.configured ? "configured" : "configuration not finished"}
          {" · "}
          {funded ? "funded" : "no deposit yet"}
        </p>
      )}

      {funded ? (
        <output className="success">
          <span className="success-mark" aria-hidden>
            ✓
          </span>
          <div>
            <p className="ui">Your vault holds {formatUsd(p.vaultBalance, p.decimals)} {p.flavour.usdgLabel}.</p>
            {p.depositHash ? (
              <a className="meta mono" href={txUrl(p.depositHash)} target="_blank" rel="noreferrer">
                Deposit {shortAddress(p.depositHash)} ↗
              </a>
            ) : (
              p.vault && (
                <a className="meta mono" href={addressUrl(p.vault)} target="_blank" rel="noreferrer">
                  See its deposits on the explorer ↗
                </a>
              )
            )}
          </div>
        </output>
      ) : (
        <div className="field field-inline">
          <label htmlFor="deposit" className="ui">
            First deposit
          </label>
          <div className="input-unit" data-unit="$">
            <span aria-hidden>$</span>
            <input id="deposit" className="input mono" inputMode="decimal" value={p.deposit.value} onChange={(e) => p.deposit.onChange(e.target.value)} disabled={p.busy} />
          </div>
          <span className={p.deposit.error ? "meta text-fail" : "meta"}>{p.deposit.error ?? `${p.flavour.usdgLabel}, from your wallet into the vault.`}</span>
        </div>
      )}

      {oneTx && showFinish && (
        <ol className="plan one-tx" aria-label="Still to do">
          {steps
            .filter((st) => st.id === "faucet")
            .map((st) => (
              <li key={st.id} className="meta">
                {st.label}
              </li>
            ))}
          <li className="meta" data-done={p.plan?.approveCovered || undefined}>
            Approve USDG
            {p.plan?.approveCovered ? <span className="chip chip-accent">Done: your approval already covers it</span> : null}
          </li>
          <li className="meta">Create vault: one transaction, configured and funded</li>
        </ol>
      )}
      {!oneTx && showFinish && (
        <ol className="plan" aria-label="Still to do">
          {steps.map((st) => (
            <li key={st.id} className="meta">
              {st.label}
            </li>
          ))}
        </ol>
      )}
      {!done && p.plan?.blocked && (
        <Notice tone="guard" title="Can't finish yet" action={<ErrorActionButton message={p.plan.blocked} onAction={p.onErrorAction} />}>
          {p.plan.blocked}
        </Notice>
      )}
      {p.runError && p.runError !== p.plan?.blocked && (
        <Notice tone="fail" title="Setup stopped" action={<ErrorActionButton message={p.runError} onAction={p.onErrorAction} />}>
          {p.runError}
        </Notice>
      )}

      {showFinish && (
        <div className="row wrap">
          <button className="btn btn-primary" onClick={p.onFinish} disabled={!p.ready || p.busy || Boolean(!funded && p.deposit.error)}>
            {finishLabel}
          </button>
          {!p.ready && <span className="meta">Connect and switch to Robinhood Chain testnet first.{oneTx ? ` Then ${prompts}.` : ""}</span>}
          {p.ready && (
            <span className="meta">
              {oneTx
                ? `${prompts}.`
                : `${steps.length === 1 ? "One wallet confirmation" : `${steps.length} wallet confirmations, one at a time`}${p.linkAfter ? ", then one signature to connect Glance" : ""}.`}
            </span>
          )}
        </div>
      )}

      {funded && (
        <form
          className="add-more"
          aria-labelledby="add-more-h"
          onSubmit={(e) => {
            e.preventDefault();
            if (!p.busy && !p.addMore.error && p.addMore.plan && p.addMore.plan.steps.length > 0 && !p.addMore.plan.blocked) p.addMore.onSubmit();
          }}
        >
          <p className="ui" id="add-more-h">
            Add more USDG
          </p>
          <p className="meta">A separate deposit: only what you type here goes in.</p>
          <div className="row wrap">
            <div className="input-unit" data-unit="$">
              <span aria-hidden>$</span>
              <input
                aria-label="Amount to add"
                className="input mono"
                inputMode="decimal"
                placeholder="0.00"
                value={p.addMore.value}
                onChange={(e) => p.addMore.onChange(e.target.value)}
                disabled={p.busy}
              />
            </div>
            <button
              type="submit"
              className="btn"
              disabled={!p.ready || p.busy || Boolean(p.addMore.error) || !p.addMore.plan || p.addMore.plan.steps.length === 0 || Boolean(p.addMore.plan.blocked)}
            >
              Deposit more
            </button>
          </div>
          {(p.addMore.error || p.addMore.plan?.blocked) && <p className="meta text-fail">{p.addMore.error ?? p.addMore.plan?.blocked}</p>}
          {p.addMore.plan && p.addMore.plan.steps.length > 0 && !p.addMore.plan.blocked && (
            <p className="meta">{p.addMore.plan.steps.map((s) => s.label).join(", then ")}.</p>
          )}
        </form>
      )}
    </div>
  );
}
