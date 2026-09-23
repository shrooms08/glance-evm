"use client";
/**
 * One owner transaction, start to finish: check it against the chain first (so a refusal is explained before the
 * wallet even opens), ask the owner's wallet to sign and send it, then wait for Robinhood Chain testnet to include it.
 * Every state is reported: checking, waiting for the wallet, pending with its hash, confirmed, or failed with the
 * reason. The console never signs anything itself.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { Abi, Address, Hex } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { publicClient } from "./chain";
import { CHAIN_ID } from "./deployment";
import { SingleFlight } from "./singleFlight";
import { describeTxError, TX_MESSAGES } from "./txMessages";

export type TxState =
  | { status: "idle" }
  | { status: "checking"; label: string }
  | { status: "wallet"; label: string }
  | { status: "pending"; label: string; hash: Hex }
  | { status: "confirmed"; label: string; hash: Hex }
  | { status: "failed"; label: string; message: string; hash?: Hex };

export interface TxRequest {
  label: string;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

export function useOwnerTx(usdgDecimals: number) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });
  // One owner transaction at a time: a double click never sends a second one.
  const flight = useRef(new SingleFlight());

  const run = async (req: TxRequest): Promise<Hex | null> => {
      const { label, ...call } = req;
      const fail = (err: unknown, hash?: Hex) => {
        setState({ status: "failed", label, message: describeTxError(err, { usdgDecimals }), hash });
        return null;
      };
      if (!address) return fail(new Error("no wallet"));
      setState({ status: "checking", label });
      try {
        await publicClient.simulateContract({ ...call, account: address } as never);
      } catch (err) {
        return fail(err);
      }
      setState({ status: "wallet", label });
      let hash: Hex;
      try {
        hash = await writeContractAsync({ ...call, chainId: CHAIN_ID } as never);
      } catch (err) {
        return fail(err);
      }
      setState({ status: "pending", label, hash });
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status !== "success") {
          // Replay against the state just before its block to recover the reason.
          try {
            await publicClient.simulateContract({ ...call, account: address, blockNumber: receipt.blockNumber - 1n } as never);
            return fail(new Error("reverted"), hash);
          } catch (err) {
            return fail(err, hash);
          }
        }
      } catch {
        setState({ status: "failed", label, message: TX_MESSAGES.unconfirmed(hash), hash });
        return null;
      }
      setState({ status: "confirmed", label, hash });
      // Every read on the page refetches: the vault's balances, the wallet's, and the chain state behind each step.
      void queryClient.invalidateQueries();
      return hash;
  };

  /** Sends one owner transaction. While one is in flight, any further call is ignored and returns null. */
  const send = async (req: TxRequest): Promise<Hex | null> => (await flight.current.run(() => run(req))) ?? null;

  const reset = useCallback(() => setState({ status: "idle" }), []);
  const busy = state.status === "checking" || state.status === "wallet" || state.status === "pending";
  return { state, send, reset, busy };
}
