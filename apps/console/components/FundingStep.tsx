"use client";
/**
 * Get started, step 3: gas and USDG, from the starter fund, by themselves. The page re-reads the wallet every 5 seconds
 * while the tab is visible, so each row turns Done the moment the funds arrive: no refresh, no clicks.
 *   on     sent automatically (the row shows the transaction until it lands)
 *   empty  "Our starter fund is empty right now…": the faucet site instead, still noticed automatically
 *   off    no starter fund on this API: the faucet site
 */
import { txUrl } from "@/lib/chain";
import { formatUsd, shortAddress } from "@/lib/format";

import { Notice } from "./Notice";

export const PUBLIC_GAS_FAUCET = "https://faucet.testnet.chain.robinhood.com";
export const PAXOS_FAUCET = "https://faucet.paxos.com/";
export const EMPTY_GAS_LINE = "Our starter fund is empty right now. Get test ETH from the Robinhood testnet faucet instead.";
export const EMPTY_USDG_LINE = "Our starter fund is empty right now. Claim from the Paxos faucet instead.";

export type FundSource = "on" | "empty" | "off";
export type SendState = { state: "idle" } | { state: "sending" } | { state: "sent"; txHash: string } | { state: "failed"; message: string };

export function FundingStep(p: {
  hasEth: boolean;
  hasUsdg: boolean;
  usdgKey: "paxos" | "test";
  walletUsdg: bigint;
  usdgDecimals: number;
  source: { gas: FundSource; usdg: FundSource };
  connected: boolean;
  gas: SendState;
  usdg: SendState;
  onGetGas(): void;
  onGetUsdg(): void;
}) {
  return (
    <ul className="checks">
      <li className="check" data-ok={p.hasEth || undefined}>
        <span aria-hidden>{p.hasEth ? "✓" : "○"}</span>
        <span>
          Test ETH for gas{p.hasEth ? ": arrived." : ""}
          {!p.hasEth && <Row source={p.source.gas} send={p.gas} what="test ETH" empty={EMPTY_GAS_LINE} link={{ href: PUBLIC_GAS_FAUCET, label: "faucet.testnet.chain.robinhood.com" }} connected={p.connected} onRetry={p.onGetGas} />}
        </span>
      </li>
      <li className="check" data-ok={p.hasUsdg || undefined}>
        <span aria-hidden>{p.hasUsdg ? "✓" : "○"}</span>
        <span>
          {p.usdgKey === "paxos" ? (
            <>
              Paxos USDG{p.hasUsdg ? ": arrived." : ""}
              {!p.hasUsdg && (
                <Row
                  source={p.source.usdg}
                  send={p.usdg}
                  what="20 starter USDG"
                  empty={EMPTY_USDG_LINE}
                  link={{ href: PAXOS_FAUCET, label: "faucet.paxos.com", note: "Choose Robinhood Chain testnet and paste your wallet address." }}
                  connected={p.connected}
                  onRetry={p.onGetUsdg}
                />
              )}
            </>
          ) : (
            "TestUSDG: step 4 takes it from its on-chain faucet for you"
          )}
          {p.walletUsdg > 0n && <span className="meta mono"> · your wallet holds {formatUsd(p.walletUsdg, p.usdgDecimals)}</span>}
        </span>
      </li>
    </ul>
  );
}

function Row(p: { source: FundSource; send: SendState; what: string; empty: string; link: { href: string; label: string; note?: string }; connected: boolean; onRetry(): void }) {
  const link = (
    <>
      {" "}
      <a href={p.link.href} target="_blank" rel="noreferrer">
        {p.link.label} ↗
      </a>
      {p.link.note ? ` ${p.link.note}` : ""} This row ticks itself when it lands.
    </>
  );
  if (p.source === "off") return <span className="meta">: {link}</span>;
  if (p.source === "empty") {
    return (
      <span className="meta">
        . {p.empty}
        {link}
      </span>
    );
  }
  if (p.send.state === "sent") {
    return (
      <span className="meta">
        {" "}
        On its way:{" "}
        <a className="mono" href={txUrl(p.send.txHash)} target="_blank" rel="noreferrer">
          {shortAddress(p.send.txHash)} ↗
        </a>
        . This row ticks itself when it lands.
      </span>
    );
  }
  if (p.send.state === "failed") {
    return (
      <Notice
        tone="fail"
        title={`No ${p.what} sent`}
        action={
          <button className="btn btn-small btn-primary" onClick={p.onRetry} disabled={!p.connected}>
            Try again
          </button>
        }
      >
        {p.send.message}
        {link}
      </Notice>
    );
  }
  return <span className="meta">{p.send.state === "sending" ? ` Sending you ${p.what}…` : ` Glance sends you ${p.what} as soon as your wallet is on the network.`}</span>;
}
