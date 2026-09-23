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
  /** Voice (see src/voice). Keys stay on the server; placeholder values count as unset. */
  DEEPGRAM_API_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
  /** Deepgram model: nova-3 is its current general model and supports keyterm prompting. */
  DEEPGRAM_MODEL: z.string().default("nova-3"),
  FISH_API_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
  /** Fish Audio model header (the API's default is s2.1-pro). */
  FISH_MODEL: z.string().default("s2.1-pro"),
  /** Fish Audio voice (reference_id). Default: "Calm Narrator", a calm, clear male voice from Fish's public library. */
  FISH_VOICE_ID: z.string().default("790560d72d4d455ba0464995cd534f27"),
  /** Fish Audio latency mode: low | normal | balanced. */
  FISH_LATENCY: z.enum(["low", "normal", "balanced"]).default("balanced"),
  /** Claude model for voice intents: a fast one, since this is on the path from key release to the reply. */
  INTENT_MODEL: z.string().default("claude-haiku-4-5"),
  /** "fake": simulated transcription and speech, for testing the voice path without keys (refused in production). */
  VOICE_PROVIDERS: z.enum(["auto", "fake"]).default("auto"),
  VOICE_FAKE_TRANSCRIPT: z.string().optional(),
  VOICE_FAKE_DELAY_MS: z.coerce.number().int().min(0).max(10_000).optional(),
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
