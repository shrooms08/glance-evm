/**
 * Environment configuration, validated once at startup. See .env.example for every variable.
 */
import { resolve } from "node:path";
import { z } from "zod";

const hexKey = /^0x[0-9a-fA-F]{64}$/;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8790),
  RPC_URL: z.url().default("https://rpc.testnet.chain.robinhood.com"),
  DEPLOYMENT_FILE: z.string().default(resolve(import.meta.dirname, "../../../deployments/46630.json")),
  /** Where each stand-in feed gets its price (shared with apps/keeper). */
  PRICE_SOURCES_FILE: z.string().default(resolve(import.meta.dirname, "../../../config/price-sources.json")),
  /** The keeper's pause switch file, reported by /health. */
  KEEPER_PAUSE_FILE: z.string().default(resolve(import.meta.dirname, "../../../keeper.paused")),
  EXPLORER_URL: z.url().default("https://explorer.testnet.chain.robinhood.com"),
  /** Vault used when a request names none (GET /price, /health's feed states). Defaults to the deployment's primary. */
  DEFAULT_VAULT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "DEFAULT_VAULT must be a 0x address")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  AGENT_PRIVATE_KEY: z
    .string()
    .regex(hexKey, "AGENT_PRIVATE_KEY must be 0x followed by 64 hex characters")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  ANTHROPIC_API_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),
  /** Comma separated. Chrome extension origins look like chrome-extension://<id>. */
  CORS_ORIGINS: z.string().default(""),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  TRADE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** Trust X-Forwarded-For for the client IP. Only enable behind a proxy you control. */
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** How far back /activity scans when a vault's creation block is unknown. ~0.17s blocks: 2M is about 4 days. */
  ACTIVITY_LOOKBACK_BLOCKS: z.coerce.bigint().default(2_000_000n),
});

export type Config = z.infer<typeof envSchema> & { corsOrigins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Never echo values: AGENT_PRIVATE_KEY may be among them.
    const fields = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${fields}`);
  }
  const corsOrigins = parsed.data.CORS_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return { ...parsed.data, corsOrigins };
}
