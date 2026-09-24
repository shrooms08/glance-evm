/** Every absolute agent expiry the console builds stays at least 10 minutes under the vault's 30-day maximum. */
import { describe, expect, it } from "vitest";

import { MAX_AGENT_TTL_SECONDS, SAFETY_MARGIN_SECONDS, safeAgentExpiry } from "../lib/agentExpiry";
import { demoVaults, VAULT_SETUP } from "../lib/deployment";
import { setupPlan, type SetupSnapshot } from "../lib/setup";

const NOW = 1_790_300_000;

describe("safeAgentExpiry", () => {
  it("caps a 30-day request at 30 days minus the 10-minute margin", () => {
    expect(SAFETY_MARGIN_SECONDS).toBe(600);
    expect(safeAgentExpiry(NOW, MAX_AGENT_TTL_SECONDS)).toBe(BigInt(NOW + 30 * 86_400 - 600));
    expect(safeAgentExpiry(NOW, MAX_AGENT_TTL_SECONDS + 1)).toBe(BigInt(NOW + 30 * 86_400 - 600));
  });

  it("leaves shorter requests alone, including the 29 days the console renews for", () => {
    expect(safeAgentExpiry(NOW, 29 * 86_400)).toBe(BigInt(NOW + 29 * 86_400));
    expect(safeAgentExpiry(NOW, 3_600)).toBe(BigInt(NOW + 3_600));
  });

  it("survives a chain up to 10 minutes ahead of the block time it was built from", () => {
    const expiry = safeAgentExpiry(NOW, MAX_AGENT_TTL_SECONDS);
    const landsAt = NOW + SAFETY_MARGIN_SECONDS; // the transaction is mined 10 minutes later
    expect(expiry <= BigInt(landsAt + MAX_AGENT_TTL_SECONDS)).toBe(true); // GlanceVault's own check
  });
});

describe("where the console sets an absolute expiry", () => {
  it("the setup's renew step for an existing vault uses it", () => {
    const paxos = demoVaults.find((d) => d.key === "paxos")!;
    const s: SetupSnapshot = {
      owner: "0x03dAC9899f5153fBd9c5EeFEf8E8B46D7f3426CA",
      now: NOW,
      vault: "0xEb7371e40bc863697De3efAbD99e51729D57D3Eb",
      vaultUsdg: paxos.usdg,
      tokens: [],
      routerApproved: true,
      agent: paxos.agent,
      agentExpiry: NOW + 86_400, // under 7 days left: renew
      ownerUsdg: 0n,
      faucetRemaining: null,
      allowance: 0n,
      factoryAllowance: 0n,
      vaultUsdgBalance: 1n,
    };
    const agent = setupPlan(s, paxos, 6, 0n, false, null).steps.find((st) => st.id === "agent")!;
    expect(agent.call.args).toEqual([paxos.agent, safeAgentExpiry(NOW, VAULT_SETUP.agentTtlSeconds)]);
  });
});
