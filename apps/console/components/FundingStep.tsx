"use client";
/**
 * Get started, step 3: test ETH for gas and USDG, balance-aware. The page re-reads the wallet every 5 seconds while the
 * tab is visible, so each row turns Done the moment the funds arrive: no refresh.
 *   Gas   "Get gas" (one click: Glance's own faucet sends 0.0005 test ETH) when the API has one; else the public faucet
 *   USDG  the Paxos faucet (choose Robinhood Chain testnet); noticed automatically when it lands
 */
import { txUrl } from "@/lib/chain";
import { formatUsd, shortAddress } from "@/lib/format";

import { Notice } from "./Notice";

export const PUBLIC_GAS_FAUCET = "https://faucet.testnet.chain.robinhood.com";
export const PAXOS_FAUCET = "https://faucet.paxos.com/";

export function FundingStep(p: {
  hasEth: boolean;
  hasUsdg: boolean;
  usdgKey: "paxos" | "test";
  walletUsdg: bigint;
  usdgDecimals: number;
  /** Glance's own gas faucet is on (the API has FAUCET_PRIVATE_KEY). */
  faucet: boolean;
  connected: boolean;
  gas: { state: "idle" } | { state: "sending" } | { state: "sent"; txHash: string } | { state: "failed"; message: string };
  onGetGas(): void;
}) {
  return (
    <ul className="checks">
      <li className="check" data-ok={p.hasEth || undefined}>
        <span aria-hidden>{p.hasEth ? "✓" : "○"}</span>
        <span>
          Test ETH for gas{p.hasEth ? ": arrived." : ""}
          {!p.hasEth && p.faucet && p.gas.state !== "sent" && (
            <>
              {" "}
              <button className="btn btn-small btn-primary" onClick={p.onGetGas} disabled={!p.connected || p.gas.state === "sending"}>
                {p.gas.state === "sending" ? "Sending…" : "Get gas"}
              </button>
            </>
          )}
          {!p.hasEth && p.gas.state === "sent" && (
            <span className="meta">
              {" "}
              On its way:{" "}
              <a className="mono" href={txUrl(p.gas.txHash)} target="_blank" rel="noreferrer">
                {shortAddress(p.gas.txHash)} ↗
              </a>
              . This row ticks itself when it lands.
            </span>
          )}
          {!p.hasEth && (!p.faucet || p.gas.state === "failed") && (
            <>
              {" "}
              from the public faucet:{" "}
              <a href={PUBLIC_GAS_FAUCET} target="_blank" rel="noreferrer">
                faucet.testnet.chain.robinhood.com ↗
              </a>
            </>
          )}
          {p.gas.state === "failed" && (
            <Notice tone="fail" title="No gas sent">
              {p.gas.message}
            </Notice>
          )}
        </span>
      </li>
      <li className="check" data-ok={p.hasUsdg || undefined}>
        <span aria-hidden>{p.hasUsdg ? "✓" : "○"}</span>
        <span>
          {p.usdgKey === "paxos" ? (
            <>
              Paxos USDG:{" "}
              {p.hasUsdg ? (
                "arrived."
              ) : (
                <>
                  <a href={PAXOS_FAUCET} target="_blank" rel="noreferrer">
                    faucet.paxos.com ↗
                  </a>{" "}
                  and choose Robinhood Chain testnet. Paste your wallet address there; this row ticks itself when it lands.
                </>
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
