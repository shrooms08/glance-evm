/**
 * The Glance agent after a key rotation: the API's /health names the agent it trades from; a vault that still names
 * another shows "Approve new Glance agent" (one setAgent signature), and a new vault's setup authorises the new agent.
 * No wallet, no transactions.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { zeroAddress, type Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewAgentCard } from "../components/NewAgentCard";
import { demoVaults } from "../lib/deployment";
import { glanceAgent, needsNewAgent, withGlanceAgent } from "../lib/glanceAgent";
import { consoleVaultConfig, setupPlan, type SetupSnapshot } from "../lib/setup";

afterEach(cleanup);

const paxos = demoVaults.find((d) => d.key === "paxos")!;
const NEW_AGENT: Address = "0x1111111111111111111111111111111111111111";
const NOW = 1_790_300_000;

describe("which agent Glance trades from", () => {
  it("the API's key when loaded (checksummed); nothing when no key is loaded or /health hasn't answered", () => {
    expect(glanceAgent({ agent: { address: NEW_AGENT.toLowerCase() as Address, keyLoaded: true } })).toBe(NEW_AGENT);
    expect(glanceAgent({ agent: { address: null, keyLoaded: false } })).toBeNull();
    expect(glanceAgent(undefined)).toBeNull();
  });

  it("a vault needs the new agent only when it names another one", () => {
    expect(needsNewAgent(paxos.agent, NEW_AGENT)).toBe(true);
    expect(needsNewAgent(zeroAddress, NEW_AGENT)).toBe(true);
    expect(needsNewAgent(NEW_AGENT, NEW_AGENT)).toBe(false);
    expect(needsNewAgent(paxos.agent, null)).toBe(false); // the API hasn't said: suggest nothing
  });
});

describe("Approve new Glance agent", () => {
  it("shows when the vault's agent differs, and one click sends setAgent for the API's agent", () => {
    const approve = vi.fn(async () => true);
    render(<NewAgentCard vaultAgent={paxos.agent} apiAgent={NEW_AGENT} approve={approve} />);
    expect(screen.getByRole("heading", { name: "Approve new Glance agent" })).toBeTruthy();
    expect(screen.getByText(/One wallet signature/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve new Glance agent" }));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(NEW_AGENT);
  });

  it("hidden when the vault already names the API's agent, or when the API hasn't said", () => {
    const { container } = render(<NewAgentCard vaultAgent={NEW_AGENT} apiAgent={NEW_AGENT} approve={vi.fn()} />);
    expect(container.innerHTML).toBe("");
    cleanup();
    const again = render(<NewAgentCard vaultAgent={paxos.agent} apiAgent={null} approve={vi.fn()} />);
    expect(again.container.innerHTML).toBe("");
  });

  it("a vault set up after the rotation authorises the new agent (step by step, and the one-transaction config)", () => {
    const flavour = withGlanceAgent(paxos, NEW_AGENT);
    const s: SetupSnapshot = {
      owner: "0x03dAC9899f5153fBd9c5EeFEf8E8B46D7f3426CA",
      now: NOW,
      vault: "0xEb7371e40bc863697De3efAbD99e51729D57D3Eb",
      vaultUsdg: paxos.usdg,
      tokens: [],
      routerApproved: true,
      agent: paxos.agent, // the old key, far from expiry: still replaced
      agentExpiry: NOW + 20 * 86_400,
      ownerUsdg: 0n,
      faucetRemaining: null,
      allowance: 0n,
      factoryAllowance: 0n,
      vaultUsdgBalance: 1n,
    };
    const step = setupPlan(s, flavour, 6, 0n, false, null).steps.find((st) => st.id === "agent")!;
    expect(step.call.functionName).toBe("setAgent");
    expect(step.call.args[0]).toBe(NEW_AGENT);
    expect(consoleVaultConfig(flavour, 6).agent).toBe(NEW_AGENT);
    expect(withGlanceAgent(paxos, null)).toBe(paxos);
  });
});
