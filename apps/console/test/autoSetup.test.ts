/**
 * "Set me up" runs itself, in order: network, gas, USDG, create (which chains the Glance link), link; each once per
 * visit, never while something is running, and waiting (not repeating) while funds are on their way. And the plan up
 * front counts the wallet prompts left.
 */
import { describe, expect, it } from "vitest";

import { GAS_ENOUGH, nextAutoAction, promptPlan, type AutoAction, type AutoState } from "../lib/autoSetup";

const usdg = (n: number) => BigInt(n) * 1_000_000n;
const base: AutoState = {
  connected: true,
  onChain: true,
  eth: 0n,
  walletUsdg: 0n,
  usdgDecimals: 6,
  deposit: usdg(20),
  vaultReady: false,
  glancePresent: true,
  linked: false,
  faucet: { gas: true, usdg: true },
  busy: false,
  tried: new Set(),
};
const next = (o: Partial<AutoState>) => nextAutoAction({ ...base, ...o });

describe("the automatic order", () => {
  it("network, then gas, then USDG, then create, then (for a vault made elsewhere) link", () => {
    expect(next({ connected: false })).toBeNull(); // connecting is the one click
    expect(next({ onChain: false })).toBe("switch-network");
    expect(next({})).toBe("get-gas");
    expect(next({ eth: GAS_ENOUGH * 3n })).toBe("get-usdg");
    expect(next({ eth: GAS_ENOUGH * 3n, walletUsdg: usdg(20) })).toBe("create");
    expect(next({ eth: GAS_ENOUGH * 3n, walletUsdg: 0n, vaultReady: true })).toBe("link");
    expect(next({ vaultReady: true, linked: true })).toBeNull();
  });

  it("each once per visit: while the funds are on their way it waits, it doesn't send again", () => {
    const tried = new Set<AutoAction>(["get-gas"]);
    expect(next({ tried })).toBeNull(); // no ETH yet: waiting for the gas to land
    expect(next({ tried, eth: GAS_ENOUGH / 2n })).toBe("get-usdg"); // some gas landed: go on
    expect(next({ tried: new Set<AutoAction>(["get-gas", "get-usdg"]), eth: GAS_ENOUGH })).toBeNull(); // waiting for USDG
    expect(next({ tried: new Set<AutoAction>(["switch-network"]), onChain: false })).toBeNull(); // refused: the button is there
  });

  it("nothing starts while something is running, or while the wallet is still being read", () => {
    expect(next({ busy: true })).toBeNull();
    expect(next({ eth: null })).toBeNull();
  });

  it("no starter fund (off or empty): it waits for funds from the faucet sites, then goes on by itself", () => {
    const off = { faucet: { gas: false, usdg: false } };
    expect(next({ ...off })).toBeNull();
    expect(next({ ...off, eth: GAS_ENOUGH / 4n })).toBeNull(); // has some gas: USDG next, from the Paxos faucet
    expect(next({ ...off, eth: GAS_ENOUGH / 4n, walletUsdg: usdg(25) })).toBe("create");
  });

  it("a wallet with USDG already (5 or more) isn't sent more: it's asked for the deposit amount it has", () => {
    expect(next({ eth: GAS_ENOUGH, walletUsdg: usdg(8) })).toBeNull(); // under the 20 deposit, but no starter USDG for it
  });
});

describe("the plan up front", () => {
  it("5 wallet prompts from the start; fewer as they're done", () => {
    const fresh = { connected: false, onChain: false, vaultReady: false, approveNeeded: true, glancePresent: true, linked: false };
    expect(promptPlan(fresh)).toBe("5 wallet prompts: connect, network, approve, create, sign");
    expect(promptPlan({ ...fresh, connected: true, onChain: true })).toBe("3 wallet prompts: approve, create, sign");
    expect(promptPlan({ ...fresh, connected: true, onChain: true, approveNeeded: false })).toBe("2 wallet prompts: create, sign");
    expect(promptPlan({ ...fresh, connected: true, onChain: true, vaultReady: true, linked: true })).toBe("Nothing left to sign: you're set up.");
  });
});
