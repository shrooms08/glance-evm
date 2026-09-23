/** Creating a vault from the console mirrors `make create-vault` step for step, from chain state. */
import { zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { demoVaults, factory, stocks, VAULT_SETUP } from "../lib/deployment";
import { planSetup, vaultReady, type SetupSnapshot } from "../lib/setup";

const paxos = demoVaults.find((d) => d.key === "paxos")!;
const test = demoVaults.find((d) => d.key === "test")!;
const OWNER = "0x00000000000000000000000000000000000000aa" as Address;
const VAULT = "0x00000000000000000000000000000000000000bb" as Address;
const NOW = 1_790_000_000;

const fresh: SetupSnapshot = {
  owner: OWNER,
  now: NOW,
  vault: null,
  vaultUsdg: null,
  tokens: [],
  routerApproved: false,
  agent: zeroAddress,
  agentExpiry: 0,
  ownerUsdg: 50_000_000n,
  faucetRemaining: null,
  allowance: 0n,
  vaultUsdgBalance: 0n,
};

const configured: SetupSnapshot = {
  ...fresh,
  vault: VAULT,
  vaultUsdg: paxos.usdg,
  tokens: stocks.map((s) => ({ approved: true, feed: s.feed, openMaxAge: VAULT_SETUP.openMaxAge, closedMaxAge: VAULT_SETUP.closedMaxAge })),
  routerApproved: true,
  agent: paxos.agent,
  agentExpiry: NOW + 20 * 86_400,
};

const target = (deposit: bigint, flavour = paxos) => ({ flavour, testUsdg: flavour.key === "test", usdgDecimals: 6, deposit });

describe("planSetup", () => {
  it("does everything the script does for a new owner, in the script's order", () => {
    const { steps, blocked } = planSetup(fresh, target(10_000_000n));
    expect(blocked).toBeNull();
    expect(steps.map((s) => s.id)).toEqual([
      "create",
      ...stocks.flatMap((s) => [`approve-${s.symbol}`, `freshness-${s.symbol}`]),
      "router",
      "agent",
      "allow",
      "deposit",
    ]);
    expect(steps[0]!.call).toMatchObject({ address: factory, functionName: "createVault", args: [paxos.usdg] });
    const tsla = stocks[0]!;
    expect(steps.find((s) => s.id === `approve-${tsla.symbol}`)!.call.args).toEqual([tsla.token, tsla.feed, true]);
    expect(steps.find((s) => s.id === `freshness-${tsla.symbol}`)!.call.args).toEqual([tsla.token, 72_000, 345_600]);
    expect(steps.find((s) => s.id === "router")!.call.args).toEqual([paxos.desk, true]);
    expect(steps.find((s) => s.id === "agent")!.call.args).toEqual([paxos.agent, BigInt(NOW + 29 * 86_400)]);
  });

  it("skips everything already in place, and only deposits", () => {
    expect(planSetup(configured, target(10_000_000n)).steps.map((s) => s.id)).toEqual(["allow", "deposit"]);
    expect(planSetup({ ...configured, allowance: 10_000_000n }, target(10_000_000n)).steps.map((s) => s.id)).toEqual(["deposit"]);
    expect(planSetup(configured, target(0n)).steps).toEqual([]);
  });

  it("renews the agent when it has under 7 days left, and fixes a wrong feed or freshness", () => {
    const tired = { ...configured, agentExpiry: NOW + 6 * 86_400 };
    expect(planSetup(tired, target(0n)).steps.map((s) => s.id)).toEqual(["agent"]);
    const drifted = { ...configured, tokens: configured.tokens.map((t, i) => (i === 1 ? { ...t, openMaxAge: 3_600 } : t)) };
    expect(planSetup(drifted, target(0n)).steps.map((s) => s.id)).toEqual([`freshness-${stocks[1]!.symbol}`]);
  });

  it("stops with the script's own words when it can't finish", () => {
    expect(planSetup({ ...configured, vaultUsdg: test.usdg }, target(0n)).blocked).toMatch(/already have a Glance vault on the other USDG/);
    expect(planSetup({ ...configured, ownerUsdg: 1_000_000n }, target(10_000_000n)).blocked).toBe(
      "Not enough Paxos USDG to deposit $10. Claim some at https://faucet.paxos.com/ (Robinhood Chain testnet), or deposit less.",
    );
  });

  it("takes missing TestUSDG from its faucet, within today's allowance", () => {
    const t = { ...configured, vaultUsdg: test.usdg, agent: test.agent, ownerUsdg: 4_000_000n, faucetRemaining: 1_000_000_000n };
    const plan = planSetup(t, target(10_000_000n, test));
    expect(plan.steps.map((s) => s.id)).toEqual(["router", "faucet", "allow", "deposit"].filter((id) => id !== "router" || !t.routerApproved));
    expect(plan.steps.find((s) => s.id === "faucet")!.call.args).toEqual([6_000_000n]);
    expect(planSetup({ ...t, faucetRemaining: 1n }, target(10_000_000n, test)).blocked).toBe("Today's TestUSDG faucet allowance is used up. Deposit less, or try again tomorrow.");
  });

  it("counts step 4 done only for a configured vault that holds USDG", () => {
    expect(vaultReady(fresh, paxos, 6)).toBe(false);
    expect(vaultReady(configured, paxos, 6)).toBe(false);
    expect(vaultReady({ ...configured, vaultUsdgBalance: 1n }, paxos, 6)).toBe(true);
  });
});
