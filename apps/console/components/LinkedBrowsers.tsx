"use client";
/**
 * The Dashboard's "Linked browsers" card: every browser the owner linked to this vault (its session address, when it
 * was linked, when the link ends), with Unlink. Unlinking is the owner's signature too (EIP-712 GlanceSessionRevoke),
 * never a transaction; the API refuses that browser's trade requests from then on.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Address } from "viem";
import { useSignTypedData } from "wagmi";
import { randomNonce, revokeTypedData } from "@glance/core/session";

import { api, type LinkedBrowser } from "@/lib/api";
import { CHAIN_ID } from "@/lib/deployment";
import { formatWhen, shortAddress } from "@/lib/format";
import { reportError } from "@/lib/report";

import { Notice } from "./Notice";
import { Skeleton } from "./Skeleton";
import { useGate } from "./useGate";
import { GateNotice, type GateReason } from "./WriteGate";

export function LinkedBrowsers({ vault, owner }: { vault: Address; owner: Address }) {
  const q = useQuery({ queryKey: ["linked-browsers", vault], queryFn: () => api.linkedBrowsers(vault), refetchInterval: 30_000 });
  const client = useQueryClient();
  const gate = useGate(owner);
  const { signTypedDataAsync } = useSignTypedData();
  const [busy, setBusy] = useState<Address | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const unlink = async (sessionKey: Address) => {
    setProblem(null);
    setBusy(sessionKey);
    try {
      const message = { vault, sessionKey, nonce: randomNonce(256) };
      const typed = revokeTypedData(message, CHAIN_ID);
      const signature = await signTypedDataAsync(typed);
      await api.unlinkBrowser({ typedData: { domain: typed.domain, primaryType: typed.primaryType, message }, signature });
      await client.invalidateQueries({ queryKey: ["linked-browsers", vault] });
    } catch (err) {
      reportError("Unlink a browser", err);
      setProblem((err as Error).message.split("\n")[0] ?? "That browser wasn't unlinked.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <LinkedBrowsersCard
      sessions={q.data?.sessions}
      loading={q.isLoading}
      error={q.error ? (q.error as Error).message : null}
      reason={gate.reason}
      busy={busy}
      problem={problem}
      onUnlink={(s) => void unlink(s)}
      gateNotice={gate.reason === "no-wallet" || gate.reason === "wrong-network" ? <GateNotice reason={gate.reason} onConnect={gate.onConnect} onSwitchNetwork={gate.onSwitchNetwork} switching={gate.switching} switchError={gate.switchError} /> : null}
    />
  );
}

/** Presentational (each state is tested). */
export function LinkedBrowsersCard(p: {
  sessions?: LinkedBrowser[];
  loading: boolean;
  error: string | null;
  reason: GateReason;
  busy: Address | null;
  problem: string | null;
  onUnlink(sessionKey: Address): void;
  gateNotice?: React.ReactNode;
}) {
  return (
    <section className="card" aria-labelledby="browsers-h">
      <div className="section-head">
        <p className="eyebrow" id="browsers-h">Linked browsers</p>
      </div>
      <p className="meta">
        Browsers you allowed to ask Glance to trade this vault, within its limits. None can withdraw. Link one from Glance&apos;s settings; unlink it here.
      </p>
      {p.loading && <Skeleton lines={2} />}
      {p.error && <Notice tone="fail" title="Couldn't load the linked browsers">{p.error}</Notice>}
      {p.problem && <Notice tone="fail" title="Not unlinked" role="alert">{p.problem}</Notice>}
      {p.gateNotice}
      {p.sessions && p.sessions.length === 0 && <p className="meta pad">No browsers are linked to this vault.</p>}
      {p.sessions && p.sessions.length > 0 && (
        <table className="table">
          <thead>
            <tr><th>Browser session</th><th>Linked</th><th>Until</th><th><span className="sr">Unlink</span></th></tr>
          </thead>
          <tbody>
            {p.sessions.map((s) => (
              <tr key={s.sessionKey}>
                <td className="mono">{shortAddress(s.sessionKey)}</td>
                <td>{formatWhen(s.linkedAt)}</td>
                <td>{s.expired ? <span className="text-guard">Expired {formatWhen(s.expiresAt)}</span> : formatWhen(s.expiresAt)}</td>
                <td className="num">
                  <button className="btn btn-small" onClick={() => p.onUnlink(s.sessionKey)} disabled={p.reason !== null || p.busy !== null}>
                    {p.busy === s.sessionKey ? "Check your wallet…" : "Unlink"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
