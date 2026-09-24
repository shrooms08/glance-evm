"use client";
/**
 * One owner transaction, start to finish: check it against the chain first (so a refusal is explained before the
 * wallet even opens), ask the owner's wallet to sign and send it, then wait for Robinhood Chain testnet to include it.
 * Every state is reported: checking, waiting for the wallet, pending with its hash, confirmed, or failed with the
 * reason. Every failure is shown on the page and logged once (lib/report.ts). The console never signs anything itself.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { Abi, Address, Hex } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { publicClient } from "./chain";
import { CHAIN_ID } from "./deployment";
import { reportError } from "./report";
import { SingleFlight } from "./singleFlight";
import { describeTxError, isUnauthorizedAccount, TX_MESSAGES } from "./txMessages";

export type TxState =
  | { status: "idle" }
  | { status: "checking"; label: string }
  | { status: "wallet"; label: string }
  | { status: "pending"; label: string; hash: Hex }
  | { status: "confirmed"; label: string; hash: Hex }
  /** `reconnect`: the wallet hasn't authorised this account for the site; the page offers a Reconnect button. */
  | { status: "failed"; label: string; message: string; hash?: Hex; reconnect?: boolean };

export interface TxRequest {
  label: string;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** What executeOwnerTx needs from the chain and the wallet (the hook passes the real ones; tests pass fakes). */
export interface OwnerTxDeps {
  account: Address | undefined;
  usdgDecimals: number;
  simulate(call: Omit<TxRequest, "label">, account: Address, blockNumber?: bigint): Promise<unknown>;
  write(call: Omit<TxRequest, "label">): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
  onState(state: TxState): void;
}

/**
 * Runs one owner transaction. Returns its hash once confirmed, or null when it didn't go through; in that case the
 * state is "failed" with the reason (never back to idle) and the error has been logged once.
 */
export async function executeOwnerTx(d: OwnerTxDeps, req: TxRequest): Promise<Hex | null> {
  const { label, ...call } = req;
  const fail = (stage: string, err: unknown, hash?: Hex): null => {
    reportError(`${label}: ${stage}`, err);
    d.onState({
      status: "failed",
      label,
      message: describeTxError(err, { usdgDecimals: d.usdgDecimals, account: d.account }),
      hash,
      reconnect: isUnauthorizedAccount(err) || undefined,
    });
    return null;
  };
  if (!d.account) return fail("no wallet", new Error("No wallet account is connected."));

  d.onState({ status: "checking", label });
  try {
    await d.simulate(call, d.account);
  } catch (err) {
    return fail("simulation", err);
  }

  d.onState({ status: "wallet", label });
  let hash: Hex;
  try {
    hash = await d.write(call);
  } catch (err) {
    return fail("wallet", err);
  }

  d.onState({ status: "pending", label, hash });
  let receipt: { status: "success" | "reverted"; blockNumber: bigint };
  try {
    receipt = await d.waitForReceipt(hash);
  } catch (err) {
    reportError(`${label}: waiting for the receipt`, err);
    d.onState({ status: "failed", label, message: TX_MESSAGES.unconfirmed(hash), hash });
    return null;
  }
  if (receipt.status !== "success") {
    // Replay against the state just before its block to recover the reason.
    try {
      await d.simulate(call, d.account, receipt.blockNumber - 1n);
      return fail("reverted on chain", new Error("reverted"), hash);
    } catch (err) {
      return fail("reverted on chain", err, hash);
    }
  }
  d.onState({ status: "confirmed", label, hash });
  return hash;
}

export function useOwnerTx(usdgDecimals: number) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });
  // One owner transaction at a time: a double click never sends a second one.
  const flight = useRef(new SingleFlight());

  const deps = (): OwnerTxDeps => ({
    account: address,
    usdgDecimals,
    simulate: (call, account, blockNumber) =>
      publicClient.simulateContract({ ...call, account, ...(blockNumber !== undefined ? { blockNumber } : {}) } as never),
    write: (call) => writeContractAsync({ ...call, chainId: CHAIN_ID } as never),
    waitForReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 }),
    onState: setState,
  });

  /** Sends one owner transaction. While one is in flight, any further call is ignored and returns null. */
  const send = async (req: TxRequest): Promise<Hex | null> => {
    const hash = (await flight.current.run(() => executeOwnerTx(deps(), req))) ?? null;
    // Every read on the page refetches: the vault's balances, the wallet's, and the chain state behind each step.
    if (hash) void queryClient.invalidateQueries();
    return hash;
  };

  /** A failure outside a transaction (e.g. reading the block time first): shown and logged like any other. */
  const fail = (label: string, err: unknown) => {
    reportError(label, err);
    setState({
      status: "failed",
      label,
      message: describeTxError(err, { usdgDecimals, account: address }),
      reconnect: isUnauthorizedAccount(err) || undefined,
    });
  };

  const reset = useCallback(() => setState({ status: "idle" }), []);
  const busy = state.status === "checking" || state.status === "wallet" || state.status === "pending";
  return { state, send, fail, reset, busy };
}
