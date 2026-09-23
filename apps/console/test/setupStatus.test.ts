/**
 * Get started's step statuses come from one pure function, and Finish setup is idempotent: once the vault holds USDG
 * it never deposits again.
 */
import { zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { demoVaults, stocks, VAULT_SETUP } from "../lib/deployment";
import { addMorePlan, setupPlan, type SetupSnapshot } from "../lib/setup";
import { stepStatuses, summarize, type Activity, type StatusInputs } from "../lib/setupStatus";

const paxos = demoVaults.find((d) => d.key === "paxos")!;
const OWNER = "0x03dAC9899f5153fBd9c5EeFEf8E8B46D7f3426CA" as Address;
const VAULT = "0xEb7371e40bc863697De3efAbD99e51729D57D3Eb" as Address;
const NOW = 1_790_300_000;

const noVault: SetupSnapshot = {
  owner: OWNER,
  now: NOW,
  vault: null,
  vaultUsdg: null,
  tokens: [],
  routerApproved: false,
  agent: zeroAddress,
  agentExpiry: 0,
  ownerUsdg: 100_000_000n,
  faucetRemaining: null,
  allowance: 0n,
  vaultUsdgBalance: 0n,
};
const configured: SetupSnapshot = {
  ...noVault,
  vault: VAULT,
  vaultUsdg: paxos.usdg,
  tokens: stocks.map((s) => ({ approved: true, feed: s.feed, openMaxAge: VAULT_SETUP.openMaxAge, closedMaxAge: VAULT_SETUP.closedMaxAge })),
  routerApproved: true,
  agent: paxos.agent,
  agentExpiry: NOW + 28 * 86_400,
};
const funded: SetupSnapshot = { ...configured, vaultUsdgBalance: 30_000_000n, ownerUsdg: 0n };

const idle: Activity = { step: null, phase: "idle" };
const inputs = (snapshot: SetupSnapshot | null, over: Partial<StatusInputs> = {}): StatusInputs => ({
  connected: true,
  onChain: true,
  chain: snapshot ? { eth: 10n ** 15n, walletUsdg: snapshot.ownerUsdg, snapshot, flavour: paxos, usdgDecimals: 6 } : undefined,
  depositConfirmed: false,
  extension: true,
  activity: idle,
  ...over,
});

describe("stepStatuses", () => {
  it("no wallet: nothing is done, and the header names step 1", () => {
    const st = stepStatuses(inputs(null, { connected: false, onChain: false, extension: false }));
    expect(st).toEqual({ connect: "not-started", network: "not-started", funds: "not-started", vault: "not-started", extension: "not-started" });
    expect(summarize(st)).toMatchObject({ complete: false, text: "Next: Connect your wallet", done: 0 });
  });

  it("wrong network: step 2 is next, and switching shows Waiting for wallet", () => {
    expect(stepStatuses(inputs(null, { onChain: false })).network).toBe("not-started");
    const st = stepStatuses(inputs(null, { onChain: false, activity: { step: "network", phase: "wallet" } }));
    expect(st.network).toBe("waiting-wallet");
    expect(summarize(st).text).toBe("Add Robinhood Chain testnet: Waiting for wallet");
  });

  it("a created but unfunded vault is In progress, never Done", () => {
    const st = stepStatuses(inputs(configured));
    expect(st.vault).toBe("in-progress");
    expect(summarize(st)).toMatchObject({ complete: false, text: "Create your vault and fund it: In progress" });
  });

  it("a created, configured and funded vault is Done; with every step Done the header says Setup complete", () => {
    const st = stepStatuses(inputs(funded));
    expect(st).toEqual({ connect: "done", network: "done", funds: "done", vault: "done", extension: "done" });
    expect(summarize(st)).toEqual({ complete: true, text: "Setup complete" });
  });

  it("a funded vault whose configuration drifted is not Done (e.g. the agent is about to expire)", () => {
    const st = stepStatuses(inputs({ ...funded, agentExpiry: NOW + 86_400 }));
    expect(st.vault).toBe("in-progress");
  });

  it("a deposit confirmed this session counts even if the RPC's balance read lags", () => {
    expect(stepStatuses(inputs(configured, { depositConfirmed: true })).vault).toBe("done");
  });

  it("in flight: Waiting for wallet, then Confirming, then Done", () => {
    expect(stepStatuses(inputs(configured, { activity: { step: "vault", phase: "wallet" } })).vault).toBe("waiting-wallet");
    expect(stepStatuses(inputs(configured, { activity: { step: "vault", phase: "confirming" } })).vault).toBe("confirming");
    expect(stepStatuses(inputs(funded)).vault).toBe("done");
  });

  it("a failed transaction shows Failed, but never over a step the chain says is Done", () => {
    expect(stepStatuses(inputs(configured, { activity: { step: "vault", phase: "failed" } })).vault).toBe("failed");
    expect(stepStatuses(inputs(funded, { activity: { step: "vault", phase: "failed" } })).vault).toBe("done");
  });

  it("never says Setup complete while any step isn't Done, and never Done next to a blocked step", () => {
    const st = stepStatuses(inputs(funded, { extension: false }));
    const s = summarize(st);
    expect(s.complete).toBe(false);
    expect(s.text).toBe("Next: Install the Glance extension");
    // Funded, and the wallet has no USDG left for another deposit: Finish setup has nothing to do, so nothing to block.
    const plan = setupPlan(funded, paxos, 6, 10_000_000n);
    expect(plan).toEqual({ steps: [], blocked: null });
  });

  it("test ETH without USDG is In progress for step 3", () => {
    const st = stepStatuses(inputs({ ...noVault, ownerUsdg: 0n }));
    expect(st.funds).toBe("in-progress");
  });
});

describe("Finish setup is idempotent", () => {
  it("deposit already done, click again: no transaction at all", () => {
    expect(setupPlan(funded, paxos, 6, 10_000_000n).steps).toEqual([]);
    // Even with an amount typed and a stale balance read, a deposit confirmed this session stops a second one.
    expect(setupPlan(configured, paxos, 6, 10_000_000n, true).steps).toEqual([]);
  });

  it("a new owner's first click plans everything once, deposit last", () => {
    const ids = setupPlan(noVault, paxos, 6, 10_000_000n).steps.map((s) => s.id);
    expect(ids[0]).toBe("create");
    expect(ids.slice(-2)).toEqual(["allow", "deposit"]);
    expect(ids.filter((id) => id === "deposit")).toHaveLength(1);
  });

  it("skips what's already in place: an agent about to expire is renewed, and nothing is deposited", () => {
    expect(setupPlan({ ...funded, agentExpiry: NOW + 86_400 }, paxos, 6, 10_000_000n).steps.map((s) => s.id)).toEqual(["agent"]);
  });

  it("an unfunded, configured vault only deposits, and skips the approve when the allowance covers it", () => {
    expect(setupPlan(configured, paxos, 6, 10_000_000n).steps.map((s) => s.id)).toEqual(["allow", "deposit"]);
    expect(setupPlan({ ...configured, allowance: 10_000_000n }, paxos, 6, 10_000_000n).steps.map((s) => s.id)).toEqual(["deposit"]);
  });
});

describe("Add more USDG", () => {
  const withUsdg = { ...funded, ownerUsdg: 50_000_000n };

  it("only deposits what was typed, and asks for approval only when the allowance is short", () => {
    expect(addMorePlan(withUsdg, paxos, 6, 5_000_000n).steps.map((s) => s.id)).toEqual(["allow", "deposit"]);
    expect(addMorePlan({ ...withUsdg, allowance: 5_000_000n }, paxos, 6, 5_000_000n).steps.map((s) => s.id)).toEqual(["deposit"]);
    expect(addMorePlan({ ...withUsdg, allowance: 9_000_000n }, paxos, 6, 5_000_000n).steps.find((s) => s.id === "deposit")!.call.args).toEqual([5_000_000n]);
  });

  it("never touches configuration, and does nothing without an amount or a vault", () => {
    expect(addMorePlan({ ...withUsdg, agentExpiry: NOW + 86_400 }, paxos, 6, 5_000_000n).steps.map((s) => s.id)).toEqual(["allow", "deposit"]);
    expect(addMorePlan(withUsdg, paxos, 6, 0n)).toEqual({ steps: [], blocked: null });
    expect(addMorePlan(noVault, paxos, 6, 5_000_000n).blocked).toBe("Create your vault first.");
    expect(addMorePlan({ ...funded, ownerUsdg: 1_000_000n }, paxos, 6, 5_000_000n).blocked).toMatch(/^Not enough Paxos USDG to deposit \$5/);
  });
});
