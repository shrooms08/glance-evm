"use client";
/**
 * Which vault the console is showing (the ?vault= in the address bar, so a link shares it), the vaults to choose from,
 * and the reads every page shares.
 */
import { glanceVaultAbi, glanceVaultFactoryAbi } from "@glance/core/abi";
import { isRpcTrouble, RPC_TROUBLE_MESSAGE } from "@glance/core/rpc";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useSearchParams } from "next/navigation";
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";

import { api, ApiProblem, retryDelay, shouldRetry } from "./api";
import { CHAIN_ID, demoVaults, factory, primaryVault } from "./deployment";

export function useSelectedVault(): Address {
  const params = useSearchParams();
  const v = params.get("vault");
  return v && isAddress(v) ? getAddress(v) : primaryVault.address;
}

/** A link that keeps the selected vault. */
export function useHref() {
  const vault = useSelectedVault();
  return (path: string, to: Address = vault) => (isAddressEqual(to, primaryVault.address) ? path : `${path}?vault=${to}`);
}

export function usePathWithVault() {
  const pathname = usePathname();
  const href = useHref();
  return (to: Address) => href(pathname, to);
}

export interface VaultOption {
  address: Address;
  label: string;
  note: string;
  mine: boolean;
}

/** The vault the connected wallet owns, from the factory (one per owner). */
export function useOwnedVault() {
  const { address } = useAccount();
  const read = useReadContract({
    address: factory,
    abi: glanceVaultFactoryAbi,
    functionName: "vaultOf",
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(address), refetchInterval: 30_000 },
  });
  const owned = read.data && !isAddressEqual(read.data as Address, zeroAddress) ? (read.data as Address) : null;
  return { owned, isLoading: read.isLoading, error: read.error };
}

export function useVaultOptions(): VaultOption[] {
  const { address } = useAccount();
  const { owned } = useOwnedVault();
  const options: VaultOption[] = demoVaults.map((d) => ({
    address: d.address,
    label: d.label,
    note: d.primary ? "Primary demo, real Paxos USDG" : "Fallback, TestUSDG from its own faucet",
    mine: Boolean(address && isAddressEqual(d.owner, address)),
  }));
  if (owned && !options.some((o) => isAddressEqual(o.address, owned))) {
    options.push({ address: owned, label: "Your vault", note: "Owned by the connected wallet", mine: true });
  }
  return options;
}

const readOptions = { retry: shouldRetry, retryDelay } as const;

export function useVaultView(vault: Address) {
  return useQuery({
    queryKey: ["vault", vault],
    queryFn: () => api.vault(vault),
    ...readOptions,
    // Keep checking, faster while the testnet isn't answering, so the page recovers on its own.
    refetchInterval: (q) => (q.state.error instanceof ApiProblem && q.state.error.kind !== "not-a-vault" ? 8_000 : 30_000),
  });
}

export function useActivity(vault: Address) {
  return useQuery({
    queryKey: ["activity", vault],
    queryFn: () => api.activity(vault),
    ...readOptions,
    refetchInterval: (q) => (q.state.error instanceof ApiProblem ? 8_000 : 30_000),
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    ...readOptions,
    refetchInterval: (q) => (q.state.error instanceof ApiProblem ? 8_000 : 60_000),
  });
}

export function useCatalog() {
  return useQuery({ queryKey: ["catalog"], queryFn: () => api.catalog(), ...readOptions, staleTime: 10 * 60_000 });
}

export interface VaultChainState {
  owner: Address;
  agent: Address;
  agentExpiry: number;
  paused: boolean;
  perBuyCap: bigint;
  dailyCap: bigint;
  dailySellCap: bigint;
  maxSlippageBps: number;
  weekendCapBps: number;
  usdg: Address;
  usdgDecimals: number;
}

/**
 * The vault's settings read straight from the chain (not through the API), for the controls: an owner's change shows
 * the moment it's mined, and the controls keep working if the API is down.
 */
export function useVaultChain(vault: Address) {
  const fn = (functionName: string) => ({ address: vault, abi: glanceVaultAbi, functionName, chainId: CHAIN_ID }) as const;
  const read = useReadContracts({
    contracts: [
      fn("owner"),
      fn("agent"),
      fn("agentExpiry"),
      fn("paused"),
      fn("perBuyCap"),
      fn("dailyCap"),
      fn("dailySellCap"),
      fn("maxSlippageBps"),
      fn("weekendCapBps"),
      fn("usdg"),
      fn("usdgDecimals"),
    ] as never,
    allowFailure: false,
    query: { refetchInterval: 20_000, retry: (n, e) => isRpcTrouble(e) && n < 3, retryDelay: (a) => [1_000, 2_000, 4_000][Math.min(a, 2)]! },
  });
  const d = read.data as unknown[] | undefined;
  const data: VaultChainState | undefined = d
    ? {
        owner: d[0] as Address,
        agent: d[1] as Address,
        agentExpiry: Number(d[2] as bigint),
        paused: d[3] as boolean,
        perBuyCap: d[4] as bigint,
        dailyCap: d[5] as bigint,
        dailySellCap: d[6] as bigint,
        maxSlippageBps: Number(d[7]),
        weekendCapBps: Number(d[8]),
        usdg: d[9] as Address,
        usdgDecimals: Number(d[10]),
      }
    : undefined;
  let problem: ApiProblem | null = null;
  if (read.error) {
    problem = isRpcTrouble(read.error)
      ? new ApiProblem("rpc", RPC_TROUBLE_MESSAGE, "RPC_UNAVAILABLE")
      : new ApiProblem("not-a-vault", `${vault} isn't a Glance vault.`, "NOT_A_VAULT");
  }
  return { data, problem, isLoading: read.isLoading, refetch: read.refetch };
}
