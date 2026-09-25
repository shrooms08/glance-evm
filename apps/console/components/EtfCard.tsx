"use client";
/**
 * The Limits page's "Add SPY and QQQ to your vault": says up front how many wallet prompts it takes, then sends them one
 * after another (each one the owner's own transaction). Hidden while the ETF stand-ins aren't deployed.
 */
import { useState } from "react";

import type { EtfStock } from "@/lib/deployment";
import { etfAddPlan, listNames, promptCount, type EtfStep, type EtfTokenState } from "@/lib/etfs";

export interface EtfCardProps {
  etfs: readonly EtfStock[];
  /** The vault's tokenConfig for each ETF, in order (null while loading). */
  states: readonly EtfTokenState[] | null;
  /** Sends one owner transaction; false when it didn't go through (rejected, reverted). */
  send(step: EtfStep): Promise<boolean>;
}

export function EtfCard({ etfs, states, send }: EtfCardProps) {
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  if (etfs.length === 0) return null;
  const names = listNames(etfs.map((e) => e.symbol));
  const steps = states ? etfAddPlan(etfs, states) : null;

  const run = async () => {
    if (!steps?.length) return;
    setRunning({ done: 0, total: steps.length });
    for (const [i, step] of steps.entries()) {
      if (!(await send(step))) break; // stopped: the card shows what's still missing from chain state
      setRunning({ done: i + 1, total: steps.length });
    }
    setRunning(null);
  };

  return (
    <section className="card" aria-labelledby="etf-h">
      <h2 className="heading" id="etf-h">ETFs</h2>
      {steps === null ? (
        <p className="meta">Checking which ETFs your vault allows…</p>
      ) : steps.length === 0 ? (
        <p className="meta">Your vault can buy {names}.</p>
      ) : (
        <>
          <p className="body">
            Let the agent buy {names} (testnet stand-ins priced from Chainlink's mainnet feeds), within the same limits as every
            stock.
          </p>
          <p className="meta">
            {promptCount(steps.length)}: {steps.map((s) => s.label).join("; ")}.
          </p>
          <div className="row wrap">
            <button className="btn btn-primary" onClick={() => void run()} disabled={running !== null}>
              {running ? `Prompt ${running.done + 1} of ${running.total}…` : `Add ${names} to your vault`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
