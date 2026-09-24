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
  /**
   * More endpoints for the same chain, comma separated, tried in order when the one before fails or times out. With a
   * dedicated endpoint (e.g. QuickNode) as RPC_URL, the public RPC here is the backstop.
   */
  RPC_FALLBACK_URLS: z
    .string()
    .default("https://rpc.testnet.chain.robinhood.com")
    .refine((v) => v.split(",").map((u) => u.trim()).filter(Boolean).every((u) => URL.canParse(u) && /^https?:/.test(u)), "RPC_FALLBACK_URLS must be comma-separated http(s) URLs"),
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
  /**
   * Claude models. Haiku by default for every call; a name containing "opus" is refused at startup unless ALLOW_OPUS=1
   * (see src/llmBudget.ts). ANTHROPIC_MODEL is the older name for RESOLVER_MODEL and still works.
   */
  RESOLVER_MODEL: z.string().optional().or(z.literal("").transform(() => undefined)),
  ANTHROPIC_MODEL: z.string().optional().or(z.literal("").transform(() => undefined)),
  ALLOW_OPUS: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  /** Claude calls allowed per UTC day across the whole API; past it, the dictionary and the rules answer. */
  LLM_DAILY_CALL_LIMIT: z.coerce.number().int().min(0).default(250),
  /**
   * Daily budgets per purpose, under LLM_DAILY_CALL_LIMIT. When one runs out only that purpose falls back: the resolver
   * to the dictionary, intent to the rules, why to headlines only. OTHER is kept for upcoming features ("Show me").
   */
  LLM_BUDGET_RESOLVER: z.coerce.number().int().min(0).default(40),
  LLM_BUDGET_INTENT: z.coerce.number().int().min(0).default(80),
  LLM_BUDGET_WHY: z.coerce.number().int().min(0).default(60),
  LLM_BUDGET_OTHER: z.coerce.number().int().min(0).default(70),
  /**
   * The company-name cache (JSON, 7 days per name). The daily call counters are kept next to it (llm-usage.json).
   * Default apps/api/.cache/resolver-names.json (gitignored); in tests, memory only unless set; empty for memory only.
   */
  RESOLVER_CACHE_FILE: z.string().optional(),
  /** Voice (see src/voice). Keys stay on the server; placeholder values count as unset. */
  DEEPGRAM_API_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
  /** Deepgram model: nova-3 is its current general model and supports keyterm prompting. */
  DEEPGRAM_MODEL: z.string().default("nova-3"),
  /** Silence (ms) after which Deepgram finalises a segment mid-speech. Release sends Finalize regardless. */
  DEEPGRAM_ENDPOINTING_MS: z.coerce.number().int().min(10).max(5_000).default(100),
  /**
   * Deepgram voice for replies; the prefix picks the endpoint. Default Flux TTS "Sienna" (flux-sienna-en, /v2/speak):
   * clear, professional, calm, warm. Aura-2 voices (aura-2-athena-en) go to /v1/speak.
   */
  DEEPGRAM_TTS_VOICE: z.string().default("flux-sienna-en"),
  /**
   * Tried when DEEPGRAM_TTS_VOICE fails twice (401/402/429, first-byte timeout, connection error); "" for none. Default:
   * the Aura-2 voice closest to Sienna (aura-2-harmonia-en: American, female, empathetic, clear, calm).
   */
  DEEPGRAM_TTS_FALLBACK_VOICE: z.string().default("aura-2-harmonia-en"),
  /** Fish after the Deepgram chain ("1"). Off by default: its voice is a different person. */
  VOICE_TTS_FISH_FALLBACK: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  /** Which speech provider is tried first; the others (if their keys are set) catch failures. */
  VOICE_TTS: z.enum(["deepgram", "fish"]).default("deepgram"),
  /** How long an unused warm Deepgram streaming connection stays open (ms). */
  VOICE_WARM_IDLE_MS: z.coerce.number().int().min(0).max(600_000).default(60_000),
  FISH_API_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
  /** Fish Audio model header (the API's default is s2.1-pro). */
  FISH_MODEL: z.string().default("s2.1-pro"),
  /** Fish Audio voice (reference_id). Default: "Calm Narrator", a calm, clear male voice from Fish's public library. */
  FISH_VOICE_ID: z.string().default("790560d72d4d455ba0464995cd534f27"),
  /** Fish Audio latency mode: low | normal | balanced. */
  FISH_LATENCY: z.enum(["low", "normal", "balanced"]).default("balanced"),
  /** Claude model for voice intents: a fast one, since this is on the path from key release to the reply. */
  INTENT_MODEL: z.string().default("claude-haiku-4-5"),
  /** Claude model for "Why it moved" summaries: Haiku by default, Opus refused unless ALLOW_OPUS=1. */
  WHY_MODEL: z.string().optional().or(z.literal("").transform(() => undefined)),
  /** Company news for "Why it moved" (finnhub.io). Server-side only: never logged, never sent to a client. */
  FINNHUB_API_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
  /** Claude model for Show me, teach and guide (budget purpose "other"): Haiku by default, Opus refused unless ALLOW_OPUS. */
  SHOWME_MODEL: z.string().optional().or(z.literal("").transform(() => undefined)),
  SHOWME_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  /** Robinhood Chain mainnet, read-only: the Chainlink feeds behind the price charts (GET /chart). */
  RPC_MAINNET_URL: z.url().default("https://rpc.mainnet.chain.robinhood.com"),
  CHART_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  /** Per-IP limits for the new read endpoints. */
  WHY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  PORTFOLIO_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  /** Where RESOLVER_CACHE_FILE defaults to, relative to this package. */
  LLM_CACHE_DIR: z.string().default(resolve(import.meta.dirname, "../.cache")),
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
  /**
   * Where refused trades are recorded (JSON lines), so the console can show them next to the trades that went through.
   * A vault emits nothing for a trade it refuses, so this is the only record of preflight refusals. Empty keeps them
   * in memory only. Relative to the API's working directory.
   */
  REFUSAL_LOG_FILE: z.string().optional(),
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
