"use client";
import { glanceVaultAbi } from "@glance/core/abi";
import { useMemo, useState } from "react";
import { isAddressEqual, zeroAddress, type Abi, type Address } from "viem";

import { ProblemNotice } from "@/components/ProblemNotice";
import { Skeleton } from "@/components/Skeleton";
import { TxStatus } from "@/components/TxStatus";
import { useGate, useReconnect } from "@/components/useGate";
import { GateNotice, WriteGate } from "@/components/WriteGate";
import { safeAgentExpiry } from "@/lib/agentExpiry";
import { effectiveCap } from "@/lib/caps";
import { addressUrl, publicClient } from "@/lib/chain";
import { demoVaults, VAULT_SETUP } from "@/lib/deployment";
import { formatDuration, formatUsd, formatWhen, shortAddress, toDecimalString } from "@/lib/format";
import { parseLimits, sameLimits, type LimitsForm } from "@/lib/limits";
import { useNow } from "@/lib/useNow";
import { useOwnerTx, type TxRequest } from "@/lib/useOwnerTx";
import { useSelectedVault, useVaultChain, type VaultChainState } from "@/lib/vault";

const vaultAbi = glanceVaultAbi as Abi;

export default function LimitsPage() {
  const vault = useSelectedVault();
  const chain = useVaultChain(vault);
  const gate = useGate(chain.data?.owner);
  const reconnect = useReconnect();
  const tx = useOwnerTx(chain.data?.usdgDecimals ?? 6);
  const send = (req: Omit<TxRequest, "address" | "abi">) => tx.send({ ...req, address: vault, abi: vaultAbi }).then((hash) => {
      if (hash) void chain.refetch();
      return hash !== null;
    });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Limits</p>
          <h1 className="title">Set the leash</h1>
          <p className="meta">
            Every change here is a transaction from the owner's wallet to{" "}
            <a className="mono" href={addressUrl(vault)} target="_blank" rel="noreferrer">
              {shortAddress(vault)} ↗
            </a>
            . The agent can't change any of it.
          </p>
        </div>
      </div>

      {chain.problem && <ProblemNotice error={chain.problem} what="this vault" />}
      {!chain.problem && <GateNotice reason={gate.reason} owner={chain.data?.owner} account={gate.account} onConnect={gate.onConnect} onSwitchNetwork={gate.onSwitchNetwork} switching={gate.switching} switchError={gate.switchError} />}
      <TxStatus state={tx.state} onDismiss={tx.reset} onReconnect={() => void reconnect()} />

      {chain.isLoading && !chain.data && <div className="card"><Skeleton lines={5} /></div>}
      {chain.data && (
        <WriteGate reason={tx.busy ? "loading" : gate.reason}>
          <div className="grid grid-2">
            <Controls v={chain.data} send={send} />
            {/* Keyed so a new agent or a changed gate starts the revoke confirmation over. */}
            <AgentControls key={`${chain.data.agent}-${gate.reason}`} v={chain.data} vault={vault} send={send} onError={tx.fail} />
          </div>
          {/* Keyed by the vault's limits, so the form starts from the new values after a change is mined. */}
          <LimitsEditor
            key={`${chain.data.perBuyCap}-${chain.data.dailyCap}-${chain.data.dailySellCap}-${chain.data.maxSlippageBps}-${chain.data.weekendCapBps}`}
            v={chain.data}
            send={send}
          />
        </WriteGate>
      )}
    </div>
  );
}

type Send = (req: Omit<TxRequest, "address" | "abi">) => Promise<boolean>;

function Controls({ v, send }: { v: VaultChainState; send: Send }) {
  return (
    <section className="card" aria-labelledby="pause-h">
      <div className="between">
        <div>
          <h2 className="heading" id="pause-h">Trading</h2>
          <p className="meta">{v.paused ? "Paused: the agent can't trade at all. Your own withdrawals still work." : "On: the agent can trade within the limits below."}</p>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={!v.paused}
          aria-label={v.paused ? "Resume trading" : "Pause trading"}
          onClick={() => void send({ label: v.paused ? "Resume trading" : "Pause trading", functionName: "setPaused", args: [!v.paused] })}
        >
          <span />
        </button>
      </div>
      <p className="meta">Pausing takes effect in the next block and stops every agent trade until you resume.</p>
    </section>
  );
}

function AgentControls({ v, vault, send, onError }: { v: VaultChainState; vault: Address; send: Send; onError(label: string, err: unknown): void }) {
  const [confirming, setConfirming] = useState(false);
  const now = useNow();
  const hasAgent = !isAddressEqual(v.agent, zeroAddress);
  const active = hasAgent && now < v.agentExpiry;
  const demo = demoVaults.find((d) => isAddressEqual(d.address, vault));
  const agentToAuthorise = hasAgent ? v.agent : (demo?.agent ?? demoVaults[0]!.agent);

  const renew = async () => {
    const label = hasAgent ? "Renew the agent for 29 days" : "Authorise the Glance agent for 29 days";
    let expiry: bigint;
    try {
      // The expiry counts from chain time, never the device clock (and stays 10 minutes under the 30-day cap).
      const block = await publicClient.getBlock();
      expiry = safeAgentExpiry(Number(block.timestamp), VAULT_SETUP.agentTtlSeconds);
    } catch (err) {
      onError(label, err); // shown and logged, never an unhandled rejection
      return;
    }
    await send({ label, functionName: "setAgent", args: [agentToAuthorise, expiry] });
  };

  return (
    <section className="card danger-zone" aria-labelledby="agent-h">
      <h2 className="heading" id="agent-h">Agent</h2>
      {hasAgent ? (
        <p className="body">
          <a className="mono" href={addressUrl(v.agent)} target="_blank" rel="noreferrer">
            {shortAddress(v.agent)} ↗
          </a>{" "}
          {active ? (
            <>can trade for {formatDuration(v.agentExpiry - now)} more, until {formatWhen(v.agentExpiry)}.</>
          ) : (
            <span className="text-guard">expired {formatWhen(v.agentExpiry)}; it can't trade.</span>
          )}
        </p>
      ) : (
        <p className="body">No agent. Nothing can trade for this vault.</p>
      )}
      <div className="row wrap">
        <button className="btn" onClick={() => void renew()}>
          {hasAgent ? "Renew for 29 days" : "Authorise the Glance agent"}
        </button>
      </div>
      {hasAgent && (
        <div className="revoke">
          {!confirming ? (
            <button className="btn btn-danger" onClick={() => setConfirming(true)}>
              Revoke agent
            </button>
          ) : (
            <div className="confirm" role="alertdialog" aria-labelledby="revoke-q">
              <p className="ui" id="revoke-q">
                Revoke {shortAddress(v.agent)} now?
              </p>
              <p className="meta">It stops being able to trade in the next block. Nothing else changes: your funds stay in the vault, and you can authorise an agent again any time.</p>
              <div className="row wrap">
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    setConfirming(false);
                    void send({ label: "Revoke the agent", functionName: "revokeAgent", args: [] });
                  }}
                >
                  Yes, revoke it
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
                  Keep it
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function LimitsEditor({ v, send }: { v: VaultChainState; send: Send }) {
  const d = v.usdgDecimals;
  const initial = useMemo<LimitsForm>(
    () => ({
      perTrade: toDecimalString(v.perBuyCap, d),
      dailyBuy: toDecimalString(v.dailyCap, d),
      dailySell: toDecimalString(v.dailySellCap, d),
      slippage: toDecimalString(BigInt(v.maxSlippageBps), 2),
      weekend: toDecimalString(BigInt(v.weekendCapBps), 2),
    }),
    [v, d],
  );
  const [form, setForm] = useState<LimitsForm>(initial);

  const parsed = parseLimits(form, d);
  const current = {
    limits: {
      perTrade: { raw: v.perBuyCap.toString() },
      dailyBuy: { raw: v.dailyCap.toString() },
      dailySell: { raw: v.dailySellCap.toString() },
      maxSlippageBps: v.maxSlippageBps,
      weekendCapBps: v.weekendCapBps,
    },
  } as Parameters<typeof sameLimits>[1];
  const unchanged = parsed.ok && sameLimits(parsed.args, current);
  const errors = parsed.ok ? {} : parsed.errors;
  const closed = (raw: bigint) => formatUsd(effectiveCap(raw, "CLOSED", parsed.ok ? parsed.args[4] : v.weekendCapBps), d);

  const field = (key: keyof LimitsForm, label: string, unit: "$" | "%", hint: string) => (
    <div className="field">
      <label htmlFor={`f-${key}`} className="ui">
        {label}
      </label>
      <div className="input-unit" data-unit={unit}>
        {unit === "$" && <span aria-hidden>$</span>}
        <input
          id={`f-${key}`}
          className="input mono"
          inputMode="decimal"
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          aria-invalid={Boolean(errors[key])}
          aria-describedby={`h-${key}`}
        />
        {unit === "%" && <span aria-hidden>%</span>}
      </div>
      <p className={errors[key] ? "meta text-fail" : "meta"} id={`h-${key}`}>
        {errors[key] ?? hint}
      </p>
    </div>
  );

  return (
    <section className="card" aria-labelledby="limits-h">
      <h2 className="heading" id="limits-h">Limits</h2>
      <p className="meta">In {d === 6 ? "dollars of USDG" : "USDG"}. The vault checks every one of these on every trade.</p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!parsed.ok || unchanged) return;
          void send({ label: "Save limits", functionName: "setLimits", args: parsed.args });
        }}
      >
        <div className="fields">
          {field("perTrade", "Per trade", "$", parsed.ok ? `Up to this per trade, buy or sell. ${closed(parsed.args[0])} while closed.` : "Up to this per trade, buy or sell.")}
          {field("dailyBuy", "Buys in any 24 hours", "$", parsed.ok ? `${closed(parsed.args[1])} while the market's closed.` : "A rolling 24-hour total.")}
          {field("dailySell", "Sells in any 24 hours", "$", parsed.ok ? `${closed(parsed.args[2])} while the market's closed.` : "A rolling 24-hour total, at the oracle value.")}
          {field("slippage", "Max slippage", "%", "How far from the oracle price a fill may be. At most 10%. Halved while closed.")}
          {field("weekend", "While the market's closed", "%", "The share of each cap that applies when prices aren't moving (nights, weekends).")}
        </div>
        <div className="row wrap">
          <button className="btn btn-primary" type="submit" disabled={!parsed.ok || unchanged}>
            Save limits
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => setForm(initial)} disabled={unchanged}>
            Reset
          </button>
          {unchanged && <span className="meta">These are the vault's current limits.</span>}
        </div>
      </form>
    </section>
  );
}
