"use client";
/**
 * Dashboard, Limits and Activity are about the connected wallet's own vault, and only that. Without a wallet they show
 * a clean "Connect your wallet" screen; with a wallet but no vault, a "Create your vault" screen. No demo data, ever
 * (developers can still open a demo vault with ?dev=1).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import type { Address } from "viem";

import { useConnectModal } from "@rainbow-me/rainbowkit";

import { useHref, useMyVaults, useSelectedVault, type MyVaults } from "@/lib/vault";

import { Mark } from "./Mark";
import { ProblemNotice } from "./ProblemNotice";
import { Skeleton } from "./Skeleton";

export function OwnVaultGate({ children }: { children(vault: Address): ReactNode }) {
  const my = useMyVaults();
  const vault = useSelectedVault();
  const { openConnectModal } = useConnectModal();
  const href = useHref();
  if (vault) return <>{children(vault)}</>;
  return <VaultGateScreen state={my} onConnect={openConnectModal} startHref={href("/start", null)} pricesHref={href("/prices", null)} />;
}

/** The screens shown instead of a vault page (presentational, so each state can be tested). */
export function VaultGateScreen({
  state,
  onConnect,
  startHref,
  pricesHref,
}: {
  state: MyVaults;
  onConnect?(): void;
  startHref: string;
  pricesHref: string;
}) {
  if (state.status === "loading" || state.status === "ready") {
    return (
      <div className="page">
        <div className="card">
          <Skeleton lines={4} />
        </div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="page">
        <ProblemNotice error={state.error} what="your vault" />
      </div>
    );
  }
  const noWallet = state.status === "no-wallet";
  return (
    <div className="page">
      <section className="gate-screen" aria-labelledby="gate-h">
        <Mark size={48} />
        <h1 className="title" id="gate-h">
          {noWallet ? "Connect your wallet" : "You don't have a vault yet"}
        </h1>
        <p className="body gate-copy">
          {noWallet
            ? "Your vault, its limits and every trade the agent made or was refused show up here once you connect the wallet that owns it."
            : "Create one in a couple of wallet prompts: it comes already set up, with limits you can change any time. You stay the owner."}
        </p>
        <div className="row wrap gate-actions">
          {noWallet ? (
            <button className="btn btn-primary" onClick={onConnect}>
              Connect wallet
            </button>
          ) : (
            <Link className="btn btn-primary" href={startHref}>
              Create your vault
            </Link>
          )}
          <Link className="btn btn-ghost" href={pricesHref}>
            See live prices
          </Link>
        </div>
      </section>
    </div>
  );
}
