import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { demoVaults, loadDeployment, primaryVault, type Deployment } from "../../src/deployment.js";

const real = loadDeployment(resolve(import.meta.dirname, "../../../../deployments/46630.json"));

describe("primary demo vault", () => {
  it("is the real Paxos USDG vault on Robinhood Chain testnet", () => {
    expect(real.primaryVault).toBe("demoVaultPaxosUSDG");
    const p = primaryVault(real);
    expect(p.address).toBe("0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113");
    expect(p.usdg).toBe("0x7E955252E15c84f5768B83c41a71F9eba181802F");
    expect(p.faucetUrl).toBe("https://faucet.paxos.com/");
  });

  it("lists both vaults, primary first, and keeps the TestUSDG fallback", () => {
    const all = demoVaults(real);
    expect(all.map((v) => [v.key, v.primary])).toEqual([
      ["paxosUSDG", true],
      ["testUSDG", false],
    ]);
  });

  it("falls back to the TestUSDG vault for older records without a primary", () => {
    const old = { ...real, primaryVault: undefined, demoVaultPaxosUSDG: undefined } as Deployment;
    expect(primaryVault(old).address).toBe(real.demoVaultTestUSDG.address);
    expect(demoVaults(old)).toHaveLength(1);
  });
});

describe("DEFAULT_VAULT", () => {
  it("is optional, and validated when set", () => {
    expect(loadConfig({}).DEFAULT_VAULT).toBeUndefined();
    expect(loadConfig({ DEFAULT_VAULT: "" }).DEFAULT_VAULT).toBeUndefined();
    expect(loadConfig({ DEFAULT_VAULT: "0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D" }).DEFAULT_VAULT).toBe("0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D");
    expect(() => loadConfig({ DEFAULT_VAULT: "nope" })).toThrow(/DEFAULT_VAULT/);
  });
});
