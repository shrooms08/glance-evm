"use client";
/**
 * Link a browser to your vault. Glance's settings open this page with the vault, the browser's session address and an
 * expiry; the vault owner reads what they're allowing and signs it (an EIP-712 signature, never a transaction). The
 * API checks the signer is the vault's owner on chain before it trusts the browser. Anyone else sees why they can't.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Address } from "viem";
import { useSignTypedData } from "wagmi";
import { authorization, formatExpiry, ONLY_OWNER, randomNonce, sessionTypedData } from "@glance/core/session";

import { Notice } from "@/components/Notice";
import { ProblemNotice } from "@/components/ProblemNotice";
import { Skeleton } from "@/components/Skeleton";
import { useGate } from "@/components/useGate";
import { GateNotice, type GateReason } from "@/components/WriteGate";
import { api } from "@/lib/api";
import { addressUrl } from "@/lib/chain";
import { CHAIN_ID } from "@/lib/deployment";
import { parseLinkParams } from "@/lib/link";
import { reportError } from "@/lib/report";
import { useVaultChain } from "@/lib/vault";

export type LinkState = { step: "ready" } | { step: "signing" } | { step: "sending" } | { step: "linked"; expiresAt: number } | { step: "failed"; message: string };

export default function LinkPage() {
  const params = useSearchParams();
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const parsed = parseLinkParams(params, now);
  if (!parsed.ok) {
    return (
      <div className="page">
        <Heading />
        <Notice tone="fail" title="This link can't be used">{parsed.problem}</Notice>
      </div>
    );
  }
  return <LinkFor vault={parsed.vault} session={parsed.session} expiresAt={parsed.expiresAt} />;
}

function Heading() {
  return (
    <div className="page-head">
      <div>
        <p className="eyebrow">Link a browser</p>
        <h1 className="title">Let this browser ask Glance to trade</h1>
      </div>
    </div>
  );
}

function LinkFor({ vault, session, expiresAt }: { vault: Address; session: Address; expiresAt: number }) {
  const chain = useVaultChain(vault);
  const gate = useGate(chain.data?.owner);
  const { signTypedDataAsync } = useSignTypedData();
  const [state, setState] = useState<LinkState>({ step: "ready" });

  const sign = async () => {
    const message = { vault, sessionKey: session, expiresAt: BigInt(expiresAt), issuedAt: BigInt(Math.floor(Date.now() / 1000)), nonce: randomNonce(256) };
    const typed = sessionTypedData(message, CHAIN_ID);
    setState({ step: "signing" });
    let signature: `0x${string}`;
    try {
      signature = await signTypedDataAsync(typed);
    } catch (err) {
      reportError("Sign the browser link", err);
      return setState({ step: "failed", message: "The signature wasn't given, so nothing was linked. You can try again." });
    }
    setState({ step: "sending" });
    try {
      const res = await api.linkBrowser({ typedData: { domain: typed.domain, primaryType: typed.primaryType, message }, signature });
      setState({ step: "linked", expiresAt: res.expiresAt });
    } catch (err) {
      setState({ step: "failed", message: (err as Error).message });
    }
  };

  return (
    <div className="page">
      <Heading />
      {chain.problem && <ProblemNotice error={chain.problem} what="this vault" />}
      <LinkScreen
        vault={vault}
        session={session}
        expiresAt={expiresAt}
        loading={chain.isLoading && !chain.data}
        reason={gate.reason}
        state={state}
        onSign={() => void sign()}
        gateNotice={
          gate.reason === "no-wallet" || gate.reason === "wrong-network" ? (
            <GateNotice reason={gate.reason} onConnect={gate.onConnect} onSwitchNetwork={gate.onSwitchNetwork} switching={gate.switching} switchError={gate.switchError} />
          ) : null
        }
      />
    </div>
  );
}

/** The one screen, presentational (each state is tested). */
export function LinkScreen(p: {
  vault: Address;
  session: Address;
  expiresAt: number;
  loading: boolean;
  reason: GateReason;
  state: LinkState;
  onSign(): void;
  gateNotice?: React.ReactNode;
}) {
  const busy = p.state.step === "signing" || p.state.step === "sending";
  return (
    <section className="card" aria-labelledby="link-h">
      <p className="eyebrow" id="link-h">What you're allowing</p>
      <p className="heading">{authorization(p.expiresAt)}</p>
      <dl className="kv kv-stack">
        <div>
          <dt>Vault</dt>
          <dd>
            <a className="mono" href={addressUrl(p.vault)} target="_blank" rel="noreferrer">{p.vault} ↗</a>
          </dd>
        </div>
        <div>
          <dt>This browser's session</dt>
          <dd className="mono">{p.session}</dd>
        </div>
        <div>
          <dt>Until</dt>
          <dd>{formatExpiry(p.expiresAt)}</dd>
        </div>
      </dl>
      <p className="meta">
        Your wallet will ask for a signature, not a transaction: nothing is sent to the chain and it costs nothing. The vault&apos;s own limits still apply to every trade, and you can
        unlink this browser from the Dashboard at any time.
      </p>

      {p.state.step === "linked" ? (
        <Notice tone="ok" title="Linked">
          This browser can now ask Glance to trade your vault until {formatExpiry(p.state.expiresAt)}. You can close this tab and go back to Glance.
        </Notice>
      ) : p.loading ? (
        <Skeleton lines={2} />
      ) : p.reason === "not-owner" ? (
        <Notice tone="guard" title={ONLY_OWNER} role="alert">
          Connect the wallet that owns this vault to link a browser to it.
        </Notice>
      ) : p.gateNotice ? (
        p.gateNotice
      ) : (
        <>
          {p.state.step === "failed" && (
            <Notice tone="fail" title="Not linked" role="alert">
              {p.state.message}
            </Notice>
          )}
          <div className="row">
            <button className="btn btn-primary" onClick={p.onSign} disabled={busy || p.reason !== null}>
              {p.state.step === "signing" ? "Check your wallet…" : p.state.step === "sending" ? "Linking…" : "Sign to link this browser"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
