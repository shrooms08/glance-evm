import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { deploymentSchema, demoVaults, loadDeployment, primaryVault, type Deployment } from "../../src/deployment.js";

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

describe("vault factories", () => {
  it("reads the original factory today, and the one-transaction factory once it's recorded, keeping both", async () => {
    const { glanceFactories, factoryV2Address } = await import("@glance/core/factories");
    expect(glanceFactories(real)).toEqual([{ version: 1, address: "0x2dE74C4643FF724c54150f1F24f4d8B73F432999" }]);
    expect(factoryV2Address(real)).toBeNull();

    const withV2 = deploymentSchema.parse({
      ...JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../deployments/46630.json"), "utf8")),
      factoryV2: { address: "0xa76c3e2fe629889d8bc83b285394ec62673b02e4", kind: "glance-v2", note: "x", deployedAt: "2026-09-24T12:00Z" },
    });
    expect(withV2.factory.address).toBe("0x2dE74C4643FF724c54150f1F24f4d8B73F432999");
    expect(glanceFactories(withV2)).toEqual([
      { version: 1, address: "0x2dE74C4643FF724c54150f1F24f4d8B73F432999" },
      { version: 2, address: "0xA76C3E2fe629889D8Bc83b285394eC62673B02E4" },
    ]);
    expect(factoryV2Address(withV2)).toBe("0xA76C3E2fe629889D8Bc83b285394eC62673B02E4");
  });
});
