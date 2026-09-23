/** The extension's built-in demo vaults must match the deployment record, and default to its primary vault. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_VAULT, DEMO_VAULTS } from "../lib/settings";

const deployment = JSON.parse(readFileSync(join(import.meta.dirname, "../../../deployments/46630.json"), "utf8"));

describe("demo vaults", () => {
  it("match deployments/46630.json", () => {
    expect(DEMO_VAULTS.paxosUSDG).toBe(deployment.demoVaultPaxosUSDG.address);
    expect(DEMO_VAULTS.testUSDG).toBe(deployment.demoVaultTestUSDG.address);
  });
  it("default to the deployment's primary vault, on real Paxos USDG", () => {
    expect(deployment.primaryVault).toBe("demoVaultPaxosUSDG");
    expect(DEFAULT_VAULT).toBe(deployment[deployment.primaryVault].address);
    expect(deployment.demoVaultPaxosUSDG.usdg).toBe("0x7E955252E15c84f5768B83c41a71F9eba181802F");
  });
});
