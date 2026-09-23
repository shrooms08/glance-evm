/**
 * Creating a vault from the console does exactly what `make create-vault` does (script/CreateVault.s.sol, VaultSetup),
 * in the same order, skipping every step already in place, so a new vault can trade the moment it's funded:
 *
 *   1. createVault(usdg) on the factory (one vault per owner)
 *   2. for each of the five stocks: approve it with its feed, then set its freshness (20h open, 96h closed)
 *   3. approve the stock desk that quotes this USDG as a router
 *   4. authorise the Glance API's agent for 29 days (renewed when under 7 days are left)
 *   5. TestUSDG only: take what's missing from its faucet
 *   6. approve the deposit and deposit it
 *
 * The plan is recomputed from chain state before every step, never from what the console remembers.
 */
import { glanceVaultAbi, glanceVaultFactoryAbi, testUsdgAbi } from "@glance/core/abi";
import { formatUsd } from "@glance/core/format";
import { erc20Abi, isAddressEqual, zeroAddress, type Abi, type Address } from "viem";

import { factory, stocks, VAULT_SETUP, type DemoVault } from "./deployment";

export interface TokenState {
  approved: boolean;
  feed: Address;
  openMaxAge: number;
  closedMaxAge: number;
}

export interface SetupSnapshot {
  owner: Address;
  /** Chain time (the latest block's timestamp). */
  now: number;
  /** factory.vaultOf(owner), or null. */
  vault: Address | null;
  vaultUsdg: Address | null;
  /** In the order of `stocks`. Empty when there's no vault yet. */
  tokens: TokenState[];
  routerApproved: boolean;
  agent: Address;
  agentExpiry: number;
  ownerUsdg: bigint;
  /** TestUSDG only: how much the faucet still gives this owner today. */
  faucetRemaining: bigint | null;
  allowance: bigint;
  vaultUsdgBalance: bigint;
}

export interface SetupTarget {
  flavour: DemoVault;
  testUsdg: boolean;
  usdgDecimals: number;
  /** Raw USDG still to deposit in this run (0 once deposited). */
  deposit: bigint;
}

export interface ContractCall {
  address: Address | null; // null: the vault, which doesn't exist until step 1
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

export interface SetupStep {
  id: string;
  label: string;
  call: ContractCall;
}

export interface SetupPlan {
  steps: SetupStep[];
  /** Set when setup can't continue, in the script's own words. */
  blocked: string | null;
}

const freshVault: Pick<SetupSnapshot, "tokens" | "routerApproved" | "agent" | "agentExpiry"> = {
  tokens: stocks.map(() => ({ approved: false, feed: zeroAddress, openMaxAge: 0, closedMaxAge: 0 })),
  routerApproved: false,
  agent: zeroAddress,
  agentExpiry: 0,
};

export function planSetup(s: SetupSnapshot, t: SetupTarget): SetupPlan {
  const steps: SetupStep[] = [];
  const f = t.flavour;
  const vault = s.vault;

  if (vault && s.vaultUsdg && !isAddressEqual(s.vaultUsdg, f.usdg)) {
    return {
      steps: [],
      blocked: `You already have a Glance vault on the other USDG (${vault}); the factory allows one per owner. Pick that USDG instead.`,
    };
  }

  if (!vault) {
    steps.push({
      id: "create",
      label: `Create your vault on ${f.usdgLabel}`,
      call: { address: factory, abi: glanceVaultFactoryAbi as Abi, functionName: "createVault", args: [f.usdg] },
    });
  }
  const state = vault ? s : { ...s, ...freshVault };

  stocks.forEach((stock, i) => {
    const cfg = state.tokens[i] ?? freshVault.tokens[i]!;
    if (!cfg.approved || !isAddressEqual(cfg.feed, stock.feed)) {
      steps.push({
        id: `approve-${stock.symbol}`,
        label: `Approve ${stock.symbol} with its price feed`,
        call: { address: vault, abi: glanceVaultAbi as Abi, functionName: "setTokenApproval", args: [stock.token, stock.feed, true] },
      });
    }
    if (cfg.openMaxAge !== VAULT_SETUP.openMaxAge || cfg.closedMaxAge !== VAULT_SETUP.closedMaxAge) {
      steps.push({
        id: `freshness-${stock.symbol}`,
        label: `Set ${stock.symbol} price freshness: 20 hours open, 96 hours closed`,
        call: {
          address: vault,
          abi: glanceVaultAbi as Abi,
          functionName: "setTokenFreshness",
          args: [stock.token, VAULT_SETUP.openMaxAge, VAULT_SETUP.closedMaxAge],
        },
      });
    }
  });

  if (!state.routerApproved) {
    steps.push({
      id: "router",
      label: "Approve the stock desk as the place to trade",
      call: { address: vault, abi: glanceVaultAbi as Abi, functionName: "setRouterApproval", args: [f.desk, true] },
    });
  }

  if (!isAddressEqual(state.agent, f.agent) || state.agentExpiry < s.now + VAULT_SETUP.agentMinLeftSeconds) {
    steps.push({
      id: "agent",
      label: "Authorise the Glance agent for 29 days",
      call: { address: vault, abi: glanceVaultAbi as Abi, functionName: "setAgent", args: [f.agent, BigInt(s.now + VAULT_SETUP.agentTtlSeconds)] },
    });
  }

  if (t.deposit > 0n) {
    const amount = formatUsd(t.deposit, t.usdgDecimals);
    if (s.ownerUsdg < t.deposit) {
      const missing = t.deposit - s.ownerUsdg;
      if (!t.testUsdg) {
        return {
          steps,
          blocked: `Not enough Paxos USDG to deposit ${amount}. Claim some at https://faucet.paxos.com/ (Robinhood Chain testnet), or deposit less.`,
        };
      }
      if (s.faucetRemaining !== null && s.faucetRemaining < missing) {
        return { steps, blocked: "Today's TestUSDG faucet allowance is used up. Deposit less, or try again tomorrow." };
      }
      steps.push({
        id: "faucet",
        label: `Take ${formatUsd(missing, t.usdgDecimals)} TestUSDG from its faucet`,
        call: { address: f.usdg, abi: testUsdgAbi as Abi, functionName: "faucet", args: [missing] },
      });
    }
    if (s.allowance < t.deposit) {
      steps.push({
        id: "allow",
        label: `Let the vault take ${amount} ${f.usdgLabel}`,
        call: { address: f.usdg, abi: erc20Abi as Abi, functionName: "approve", args: [vault ?? zeroAddress, t.deposit] },
      });
    }
    steps.push({
      id: "deposit",
      label: `Deposit ${amount} ${f.usdgLabel}`,
      call: { address: vault, abi: glanceVaultAbi as Abi, functionName: "deposit", args: [t.deposit] },
    });
  }

  return { steps, blocked: null };
}

/** Step 4 is done when the vault exists, is configured exactly like the script leaves it, and holds USDG. */
export function vaultReady(s: SetupSnapshot, flavour: DemoVault, usdgDecimals: number, depositConfirmed = false): boolean {
  return vaultConfigured(s, flavour, usdgDecimals) && (s.vaultUsdgBalance > 0n || depositConfirmed);
}

/**
 * What "Finish setup" runs: the configuration steps still missing, and the first deposit only while the vault holds no
 * USDG. Once the vault holds any USDG (or a deposit confirmed in this session, even if a lagging RPC hasn't caught up
 * yet), setup never deposits again. More USDG only goes in through addMorePlan, from its own explicit input.
 */
export function setupPlan(s: SetupSnapshot, flavour: DemoVault, usdgDecimals: number, initialDeposit: bigint, depositConfirmed = false): SetupPlan {
  const funded = s.vaultUsdgBalance > 0n || depositConfirmed;
  return planSetup(s, { flavour, testUsdg: flavour.key === "test", usdgDecimals, deposit: funded ? 0n : initialDeposit });
}

/** "Add more USDG": only the funding steps (faucet for TestUSDG, approve if the allowance is short, deposit). */
export function addMorePlan(s: SetupSnapshot, flavour: DemoVault, usdgDecimals: number, amount: bigint): SetupPlan {
  if (!s.vault) return { steps: [], blocked: "Create your vault first." };
  if (amount <= 0n) return { steps: [], blocked: null };
  const plan = planSetup(s, { flavour, testUsdg: flavour.key === "test", usdgDecimals, deposit: amount });
  return { steps: plan.steps.filter((st) => st.id === "faucet" || st.id === "allow" || st.id === "deposit"), blocked: plan.blocked };
}

/** The vault exists and is configured exactly like the script leaves it (funding aside). */
export function vaultConfigured(s: SetupSnapshot, flavour: DemoVault, usdgDecimals: number): boolean {
  if (!s.vault) return false;
  const { steps, blocked } = planSetup(s, { flavour, testUsdg: flavour.key === "test", usdgDecimals, deposit: 0n });
  return !blocked && steps.length === 0;
}
