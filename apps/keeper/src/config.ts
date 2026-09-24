/**
 * Keeper configuration. Paths default to the repo layout; secrets and RPC URLs must be provided, and a missing one
 * stops the keeper with a clear message (never with the value, which may be a key).
 */
import { resolve } from "node:path";
import { z } from "zod";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

export const paths = {
  deployment: process.env.DEPLOYMENT_FILE ?? resolve(REPO_ROOT, "deployments/46630.json"),
  priceSources: process.env.PRICE_SOURCES_FILE ?? resolve(REPO_ROOT, "config/price-sources.json"),
  pauseFile: process.env.KEEPER_PAUSE_FILE ?? resolve(REPO_ROOT, "keeper.paused"),
};

/** Robinhood Chain testnet's public RPC: the fallback when the primary is unreachable. */
export const PUBLIC_TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";

const envSchema = z.object({
  KEEPER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x followed by 64 hex characters"),
  TESTNET_RPC_URL: z.url(),
  /** Used only when TESTNET_RPC_URL can't be reached, then for the rest of that run. */
  TESTNET_FALLBACK_RPC_URL: z.url().default(PUBLIC_TESTNET_RPC),
  MAINNET_RPC_URL: z.url(),
  KEEPER_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(120),
});

export type KeeperEnv = z.infer<typeof envSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): KeeperEnv {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message === "Invalid input: expected string, received undefined" ? "missing" : i.message}`);
    throw new Error(`Keeper configuration is incomplete:\n${problems.join("\n")}\nSee apps/keeper/.env.example.`);
  }
  return parsed.data;
}
