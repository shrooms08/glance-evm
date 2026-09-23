/** The vault picker lists every vault the wallet owns: one per factory, the one-transaction factory's first. */
import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { ownedFromReads } from "../lib/vault";

const V1 = "0x2dE74C4643FF724c54150f1F24f4d8B73F432999" as Address;
const V2 = "0xA76C3E2fe629889D8Bc83b285394eC62673B02E4" as Address;
const OLD = "0xEb7371e40bc863697De3efAbD99e51729D57D3Eb" as Address;
const NEW = "0x1111111111111111111111111111111111111111" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const factories = [
  { version: 1 as const, address: V1 },
  { version: 2 as const, address: V2 },
];

describe("ownedFromReads", () => {
  it("shows vaults from both factories, newest factory first", () => {
    expect(ownedFromReads(factories, [{ status: "success", result: OLD }, { status: "success", result: NEW }])).toEqual([
      { vault: NEW, factoryVersion: 2 },
      { vault: OLD, factoryVersion: 1 },
    ]);
  });

  it("skips factories where the wallet has no vault, or that couldn't be read", () => {
    expect(ownedFromReads(factories, [{ status: "success", result: OLD }, { status: "success", result: ZERO }])).toEqual([{ vault: OLD, factoryVersion: 1 }]);
    expect(ownedFromReads(factories, [{ status: "failure" }, { status: "success", result: NEW }])).toEqual([{ vault: NEW, factoryVersion: 2 }]);
    expect(ownedFromReads(factories, undefined)).toEqual([]);
  });

  it("works with only the original factory recorded (V2 not deployed yet)", () => {
    expect(ownedFromReads([factories[0]!], [{ status: "success", result: OLD }])).toEqual([{ vault: OLD, factoryVersion: 1 }]);
  });
});
