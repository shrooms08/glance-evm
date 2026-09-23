"use client";
/**
 * Everything Get started needs to know, read from the chain (never from local storage): the wallet's ETH and USDG,
 * its vault from the factory, and that vault's configuration, exactly the state `make create-vault` checks.
 */
import { glanceVaultAbi, glanceVaultFactoryAbi, testUsdgAbi } from "@glance/core/abi";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, isAddressEqual, zeroAddress, type Address } from "viem";

import { publicClient } from "./chain";
import { demoVaults, factories, factoryV2, stocks, type DemoVault } from "./deployment";
import type { SetupSnapshot } from "./setup";

export interface StartState {
  eth: bigint;
  /** The wallet's USDG, per flavour. */
  usdg: Record<DemoVault["key"], bigint>;
  usdgDecimals: Record<DemoVault["key"], number>;
  /** Which USDG the wallet's existing vault uses, if it has one. */
  vaultFlavour: DemoVault | null;
  /** Which factory created the wallet's vault (1: step-by-step, 2: one transaction), or null without a vault. */
  vaultFactory: 1 | 2 | null;
  snapshot: SetupSnapshot;
}

export async function readStartState(owner: Address, flavour: DemoVault): Promise<StartState> {
  const [paxos, test] = [demoVaults.find((d) => d.key === "paxos")!, demoVaults.find((d) => d.key === "test")!];
  const [eth, block, vaultsRaw, paxosBal, testBal, paxosDec, testDec] = await Promise.all([
    publicClient.getBalance({ address: owner }),
    publicClient.getBlock(),
    // The owner's vault in every factory (the ABIs share vaultOf). The newest factory's vault wins if there are two.
    Promise.all(factories.map((f) => publicClient.readContract({ address: f.address, abi: glanceVaultFactoryAbi, functionName: "vaultOf", args: [owner] }))),
    publicClient.readContract({ address: paxos.usdg, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    publicClient.readContract({ address: test.usdg, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    publicClient.readContract({ address: paxos.usdg, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: test.usdg, abi: erc20Abi, functionName: "decimals" }),
  ]);
  const found = factories
    .map((f, i) => ({ version: f.version, vault: vaultsRaw[i] as Address }))
    .filter((v) => !isAddressEqual(v.vault, zeroAddress))
    .sort((a, b) => b.version - a.version)[0];
  const vault = found?.vault ?? null;
  const now = Number(block.timestamp);

  let vaultUsdg: Address | null = null;
  let vaultFlavour: DemoVault | null = null;
  let tokens: SetupSnapshot["tokens"] = [];
  let routerApproved = false;
  let agent: Address = zeroAddress;
  let agentExpiry = 0;
  let vaultUsdgBalance = 0n;
  if (vault) {
    vaultUsdg = (await publicClient.readContract({ address: vault, abi: glanceVaultAbi, functionName: "usdg" })) as Address;
    vaultFlavour = demoVaults.find((d) => isAddressEqual(d.usdg, vaultUsdg!)) ?? null;
    const desk = (vaultFlavour ?? flavour).desk;
    const [configs, router, a, exp, bal] = await Promise.all([
      Promise.all(stocks.map((s) => publicClient.readContract({ address: vault, abi: glanceVaultAbi, functionName: "tokenConfig", args: [s.token] }))),
      publicClient.readContract({ address: vault, abi: glanceVaultAbi, functionName: "approvedRouters", args: [desk] }),
      publicClient.readContract({ address: vault, abi: glanceVaultAbi, functionName: "agent" }),
      publicClient.readContract({ address: vault, abi: glanceVaultAbi, functionName: "agentExpiry" }),
      publicClient.readContract({ address: vaultUsdg, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
    ]);
    tokens = configs.map((c) => {
      const [approved, feed, openMaxAge, closedMaxAge] = c as readonly [boolean, Address, number, number];
      return { approved, feed, openMaxAge: Number(openMaxAge), closedMaxAge: Number(closedMaxAge) };
    });
    routerApproved = router as boolean;
    agent = a as Address;
    agentExpiry = Number(exp);
    vaultUsdgBalance = bal as bigint;
  }

  const target = vaultFlavour ?? flavour;
  const [allowance, factoryAllowance, faucetRemaining] = await Promise.all([
    vault ? publicClient.readContract({ address: target.usdg, abi: erc20Abi, functionName: "allowance", args: [owner, vault] }) : Promise.resolve(0n),
    factoryV2 ? publicClient.readContract({ address: target.usdg, abi: erc20Abi, functionName: "allowance", args: [owner, factoryV2] }) : Promise.resolve(0n),
    target.key === "test"
      ? publicClient.readContract({ address: target.usdg, abi: testUsdgAbi, functionName: "faucetRemaining", args: [owner] }).then((x) => x as bigint)
      : Promise.resolve(null),
  ]);

  return {
    eth,
    usdg: { paxos: paxosBal, test: testBal },
    usdgDecimals: { paxos: Number(paxosDec), test: Number(testDec) },
    vaultFlavour,
    vaultFactory: found?.version ?? null,
    snapshot: {
      owner,
      now,
      vault,
      vaultUsdg,
      tokens,
      routerApproved,
      agent,
      agentExpiry,
      ownerUsdg: target.key === "paxos" ? paxosBal : testBal,
      faucetRemaining,
      allowance: allowance as bigint,
      factoryAllowance: factoryAllowance as bigint,
      vaultUsdgBalance,
    },
  };
}

export function useStartState(owner: Address | undefined, flavour: DemoVault) {
  return useQuery({
    queryKey: ["start", owner, flavour.key],
    queryFn: () => readStartState(owner!, flavour),
    enabled: Boolean(owner),
    refetchInterval: 15_000,
    retry: 3,
    retryDelay: (a) => [1_000, 2_000, 4_000][Math.min(a, 2)]!,
  });
}
