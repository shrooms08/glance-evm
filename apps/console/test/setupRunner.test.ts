/**
 * Regression: a fresh wallet couldn't create a V2 vault. The runner stopped before its first transaction (the approve)
 * because it required a vault for every step but "create", and said nothing. Every step that doesn't target the vault
 * must run without one, and every way the runner ends must be explicit.
 */
import { zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { demoVaults, stocks, VAULT_SETUP } from "../lib/deployment";
import { setupPlan, type SetupSnapshot } from "../lib/setup";
import { runSetupSteps, STOPPED_NO_VAULT, STOPPED_VAULT_NOT_VISIBLE, type RunnerDeps } from "../lib/setupRunner";

const paxos = demoVaults.find((d) => d.key === "paxos")!;
const V2 = "0xA76C3E2fe629889D8Bc83b285394eC62673B02E4" as Address;
const FRESH_WALLET = "0xE5AE75Dd9D7130FA4cf80926bab410e1d440730F" as Address;
const NEW_VAULT = "0xe359624f0376Be7FBDBD1689925800ED9a0392f5" as Address; // what the fork created for it
const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** The fresh test wallet as the chain showed it: 100 Paxos USDG, no allowance to V2, no vault in either factory. */
const fresh: SetupSnapshot = {
  owner: FRESH_WALLET,
  now: 1_790_230_780,
  vault: null,
  vaultUsdg: null,
  tokens: [],
  routerApproved: false,
  agent: zeroAddress,
  agentExpiry: 0,
  ownerUsdg: 100_000_000n,
  faucetRemaining: null,
  allowance: 0n,
  factoryAllowance: 0n,
  vaultUsdgBalance: 0n,
};
const created: SetupSnapshot = {
  ...fresh,
  vault: NEW_VAULT,
  vaultUsdg: paxos.usdg,
  tokens: stocks.map((s) => ({ approved: true, feed: s.feed, openMaxAge: VAULT_SETUP.openMaxAge, closedMaxAge: VAULT_SETUP.closedMaxAge })),
  routerApproved: true,
  agent: paxos.agent,
  agentExpiry: fresh.now + 30 * 86_400,
  ownerUsdg: 50_000_000n,
  vaultUsdgBalance: 50_000_000n,
};

/** A chain that moves on as transactions confirm: approve raises the allowance; create makes the funded vault. */
function simulatedChain(opts: { factoryV2?: Address | null; vaultAppears?: boolean } = {}) {
  let state = fresh;
  const sent: Array<{ id: string; target: Address; fn: string }> = [];
  const deps: RunnerDeps = {
    mode: "setup",
    createDeposits: true,
    sleep: async () => {},
    read: async () => ({ snapshot: state, plan: (deposited) => setupPlan(state, paxos, 6, 50_000_000n, deposited, opts.factoryV2 === undefined ? V2 : opts.factoryV2) }),
    send: vi.fn(async (step, target) => {
      sent.push({ id: step.id, target, fn: step.call.functionName });
      if (step.id === "allow-factory") state = { ...state, factoryAllowance: 50_000_000n };
      if (step.id === "create-configured" && opts.vaultAppears !== false) state = created;
      return HASH(sent.length);
    }),
    onDeposited: vi.fn(),
  };
  return { deps, sent };
}

describe("fresh wallet, one-transaction factory", () => {
  it("sends the approve (no vault needed), then the one create, then stops: 2 wallet prompts", async () => {
    const { deps, sent } = simulatedChain();
    const outcome = await runSetupSteps(deps);
    expect(sent).toEqual([
      { id: "allow-factory", target: paxos.usdg, fn: "approve" },
      { id: "create-configured", target: V2, fn: "createVaultWithConfig" },
    ]);
    expect(outcome).toEqual({ kind: "done", sent: 2 });
    expect(deps.onDeposited).toHaveBeenCalledWith(HASH(2));
  });

  it("with the allowance already there: only the create (1 prompt)", async () => {
    const { deps, sent } = simulatedChain();
    const read = deps.read;
    let first = true;
    deps.read = async () => {
      const r = await read();
      if (first) {
        first = false;
        const snapshot = { ...r.snapshot, factoryAllowance: 50_000_000n };
        return { snapshot, plan: (d) => setupPlan(snapshot, paxos, 6, 50_000_000n, d, V2) };
      }
      return r;
    };
    await runSetupSteps(deps);
    expect(sent.map((s) => s.id)).toEqual(["create-configured"]);
  });

  it("never plans a second vault when the RPC lags after the create: it stops and says so", async () => {
    const { deps, sent } = simulatedChain({ vaultAppears: false });
    const outcome = await runSetupSteps(deps);
    expect(sent.map((s) => s.id)).toEqual(["allow-factory", "create-configured"]);
    expect(outcome).toEqual({ kind: "stopped", reason: STOPPED_VAULT_NOT_VISIBLE, sent: 2 });
  });
});

describe("every ending is explicit", () => {
  it("a failed transaction ends the run: nothing else is sent", async () => {
    const { deps, sent } = simulatedChain();
    deps.send = vi.fn(async (step, target) => {
      sent.push({ id: step.id, target, fn: step.call.functionName });
      return null;
    });
    expect(await runSetupSteps(deps)).toEqual({ kind: "tx-failed", sent: 1 });
    expect(sent).toHaveLength(1);
  });

  it("a blocked plan (not enough USDG) reports why, before any prompt", async () => {
    const { deps, sent } = simulatedChain();
    const poor = { ...fresh, ownerUsdg: 1_000_000n };
    deps.read = async () => ({ snapshot: poor, plan: (d) => setupPlan(poor, paxos, 6, 50_000_000n, d, V2) });
    const outcome = await runSetupSteps(deps);
    expect(outcome.kind).toBe("blocked");
    expect(outcome.kind === "blocked" && outcome.reason).toMatch(/^Not enough Paxos USDG to deposit \$50\./);
    expect(sent).toHaveLength(0);
  });

  it("a step that targets the vault, with no vault on chain, stops with a reason instead of silently", async () => {
    const { deps } = simulatedChain({ factoryV2: null });
    // In a plan made before the vault exists, every step after "create" targets the vault (address null).
    const vaultStep = setupPlan(fresh, paxos, 6, 0n, false, null).steps.find((st) => st.id.startsWith("approve-"))!;
    expect(vaultStep.call.address).toBeNull();
    const stopped = await runSetupSteps({
      ...deps,
      read: async () => ({ snapshot: fresh, plan: () => ({ steps: [vaultStep], blocked: null }) }),
    });
    expect(stopped).toEqual({ kind: "stopped", reason: STOPPED_NO_VAULT, sent: 0 });
  });
});
