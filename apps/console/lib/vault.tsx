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
import { useAccount, useReadContracts } from "wagmi";

import { api, ApiProblem, retryDelay, shouldRetry } from "./api";
import { CHAIN_ID, demoVaults, factories, primaryVault } from "./deployment";

// ---------------------------------------------------------------------------------------------------------------------
// Whose vault: the connected wallet's own, and nobody else's (the demo vaults only with ?dev=1)
// ---------------------------------------------------------------------------------------------------------------------

/** ?dev=1: the developer fallbacks (demo vaults, any pasted vault, the TestUSDG setup). Off for everyone else. */
export function useDevMode(): boolean {
  return useSearchParams().get("dev") === "1";
}

export interface OwnedVault {
  vault: Address;
  factoryVersion: 1 | 2;
}

export type MyVaults =
  | { status: "no-wallet" }
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "none" }
  | { status: "ready"; vaults: OwnedVault[] };

/** What the connected wallet owns, as a state the pages can switch on. */
export function myVaultsState(p: { connected: boolean; isLoading: boolean; error: unknown; owned: OwnedVault[] }): MyVaults {
  if (!p.connected) return { status: "no-wallet" };
  if (p.owned.length > 0) return { status: "ready", vaults: p.owned };
  if (p.error) return { status: "error", error: p.error };
  if (p.isLoading) return { status: "loading" };
  return { status: "none" };
}

export function useMyVaults(): MyVaults {
  const { isConnected } = useAccount();
  const { owned, isLoading, error } = useOwnedVaults();
  return myVaultsState({ connected: isConnected, isLoading, error, owned });
}

/**
 * The vault to show: the ?vault= one if the wallet owns it, else the wallet's first vault. Nothing when the wallet owns
 * none: there is no fallback to a demo vault. With ?dev=1, any ?vault= is allowed, and the demo vault is the default.
 */
export function selectVault(param: string | null, owned: readonly Address[], dev: boolean): Address | null {
  const asked = param && isAddress(param) ? getAddress(param) : null;
  if (asked && (dev || owned.some((o) => isAddressEqual(o, asked)))) return asked;
  return owned[0] ?? (dev ? primaryVault.address : null);
}

export function useSelectedVault(): Address | null {
  const params = useSearchParams();
  const dev = params.get("dev") === "1";
  const my = useMyVaults();
  const owned = my.status === "ready" ? my.vaults.map((v) => v.vault) : [];
  return selectVault(params.get("vault"), owned, dev);
}

/** A link that keeps the chosen vault (when it isn't the default) and ?dev=1. */
export function useHref() {
  const params = useSearchParams();
  const dev = params.get("dev") === "1";
  const vault = params.get("vault");
  return (path: string, to: Address | null = vault && isAddress(vault) ? getAddress(vault) : null) => {
    const q = new URLSearchParams();
    if (to) q.set("vault", to);
    if (dev) q.set("dev", "1");
    const qs = q.toString();
    return qs ? `${path}?${qs}` : path;
  };
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

/** The vaults the connected wallet owns: one per factory at most (the original, and the one-transaction V2). */
export function useOwnedVaults() {
  const { address } = useAccount();
  const read = useReadContracts({
    contracts: factories.map((f) => ({
      address: f.address,
      abi: glanceVaultFactoryAbi,
      functionName: "vaultOf",
      args: [address ?? zeroAddress],
      chainId: CHAIN_ID,
    })),
    query: { enabled: Boolean(address), refetchInterval: 30_000 },
  });
  return { owned: ownedFromReads(factories, read.data), isLoading: read.isLoading, error: read.error };
}

/** Each factory's answer to vaultOf, as the vaults that exist (newest factory first), without duplicates. */
export function ownedFromReads(
  from: Array<{ version: 1 | 2; address: Address }>,
  data: ReadonlyArray<{ status: string; result?: unknown }> | undefined,
): OwnedVault[] {
  const out: OwnedVault[] = [];
  from.forEach((f, i) => {
    const r = data?.[i];
    const vault = r?.status === "success" ? (r.result as Address) : null;
    if (vault && !isAddressEqual(vault, zeroAddress) && !out.some((o) => isAddressEqual(o.vault, vault))) out.push({ vault, factoryVersion: f.version });
  });
  return out.sort((a, b) => b.factoryVersion - a.factoryVersion);
}

export type VaultMenu =
  | { kind: "none" }
  | { kind: "single"; option: VaultOption }
  | { kind: "menu"; options: VaultOption[]; paste: boolean };

/**
 * The header's vault control. Only the wallet's own vaults: nothing without one, a plain "Your vault 0x…" with one,
 * a menu listing only them with two or more. ?dev=1 adds the demo vaults and the "any other vault" box.
 */
export function vaultMenu(owned: readonly OwnedVault[], dev: boolean): VaultMenu {
  const mine: VaultOption[] = owned.map((o) => ({
    address: o.vault,
    label: owned.length > 1 ? `Your vault (${o.factoryVersion === 2 ? "one-transaction setup" : "original setup"})` : "Your vault",
    note: "Owned by the connected wallet",
    mine: true,
  }));
  if (dev) {
    const demos: VaultOption[] = demoVaults
      .filter((d) => !mine.some((m) => isAddressEqual(m.address, d.address)))
      .map((d) => ({ address: d.address, label: `${d.label} (dev)`, note: d.primary ? "Demo, real Paxos USDG" : "Demo, TestUSDG", mine: false }));
    return { kind: "menu", options: [...mine, ...demos], paste: true };
  }
  if (mine.length === 0) return { kind: "none" };
  if (mine.length === 1) return { kind: "single", option: mine[0]! };
  return { kind: "menu", options: mine, paste: false };
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
