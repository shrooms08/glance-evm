/**
 * Loads and validates deployments/<chainId>.json, the single source of truth for addresses. Nothing in the API
 * hardcodes a contract address.
 */
import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "not an address")
  .transform((v) => getAddress(v) as Address);

const contract = z.object({ address, kind: z.string() });

const vault = z.object({
  address,
  usdg: address,
  stockDesk: address,
  owner: address,
  agent: address,
  agentExpiry: z.number(),
  fundableFromFaucet: z.boolean(),
  note: z.string(),
  /** Where anyone can get this vault's USDG. */
  faucetUrl: z.string().optional(),
  /** The vault the demo points at by default. */
  primary: z.boolean().optional(),
  /** USDG balance when this record was last written (live balances come from the chain). */
  usdgBalance: z.number().optional(),
  fundedAt: z.string().optional(),
});

const stock = z.union([
  z.object({
    skipped: z.literal(false),
    token: address,
    tokenDecimals: z.number().int().min(0).max(36),
    tokenReal: z.boolean(),
    tokenSource: z.string(),
    feed: address,
    feedReal: z.boolean(),
    feedSource: z.string(),
    price: z.number(),
    priceDecimals: z.number().int(),
    priceSource: z.string(),
    priceSourceKind: z.string(),
  }),
  z.object({ skipped: z.literal(true), reason: z.string() }),
]);

export const deploymentSchema = z.object({
  chainId: z.number().int().positive(),
  blockNumber: z.number().int().nonnegative(),
  timestamp: z.number().int(),
  deployer: address,
  pricesFetchedAt: z.string().optional(),
  sequencerUptimeFeed: address,
  usdg: z.object({ address, real: z.boolean(), source: z.string() }),
  factory: contract,
  /** The one-transaction factory (GlanceVaultFactoryV2), once deployed. The original factory stays in `factory`. */
  factoryV2: contract.extend({ note: z.string().optional(), deployedAt: z.string().optional() }).optional(),
  stockDesk: contract,
  stockDeskPaxosUSDG: contract.optional(),
  demoVaultTestUSDG: vault,
  demoVaultPaxosUSDG: vault.optional(),
  /** Which demo vault is the headline. Missing in older records, which meant the TestUSDG vault. */
  primaryVault: z.enum(["demoVaultPaxosUSDG", "demoVaultTestUSDG"]).optional(),
  stocks: z.record(z.string(), stock),
});

export type Deployment = z.infer<typeof deploymentSchema>;
export type DeployedVault = z.infer<typeof vault>;

export function loadDeployment(path: string): Deployment {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read deployment file ${path}: ${(err as Error).message}`, { cause: err });
  }
  const parsed = deploymentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Deployment file ${path} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** The headline demo vault: the one marked primary, else the TestUSDG vault (always present). */
export function primaryVault(d: Deployment): DeployedVault {
  if (d.primaryVault === "demoVaultPaxosUSDG" && d.demoVaultPaxosUSDG) return d.demoVaultPaxosUSDG;
  return d.demoVaultTestUSDG;
}

/** Every demo vault, primary first, with a short label. */
export function demoVaults(d: Deployment): Array<{ key: "paxosUSDG" | "testUSDG"; vault: DeployedVault; primary: boolean }> {
  const primary = primaryVault(d);
  const all = [
    ...(d.demoVaultPaxosUSDG ? [{ key: "paxosUSDG" as const, vault: d.demoVaultPaxosUSDG }] : []),
    { key: "testUSDG" as const, vault: d.demoVaultTestUSDG },
  ].map((v) => ({ ...v, primary: v.vault.address === primary.address }));
  return all.sort((a, b) => Number(b.primary) - Number(a.primary));
}

/** Every StockDesk in the deployment, so a vault can be matched to the desk that quotes its USDG. */
export function desksOf(d: Deployment): Address[] {
  return [d.stockDesk.address, ...(d.stockDeskPaxosUSDG ? [d.stockDeskPaxosUSDG.address] : [])];
}

/** Earliest block worth scanning for events. The script records the block it ran against, just before its txs. */
export function deploymentStartBlock(d: Deployment): bigint {
  return BigInt(d.blockNumber);
}
