/**
 * Environment configuration, validated once at startup. See .env.example for every variable.
 */
import { join, resolve } from "node:path";
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
   * The drift guard: before any trade or basket leg is sent, the live market price (Finnhub, else Yahoo) and the
   * vault's oracle price may differ by at most this many basis points (200 = 2%); more, and the API refuses it (the
   * oracle is behind the market). No live quote: never blocks (logged).
   */
  LIVE_ORACLE_MAX_GAP_BPS: z.coerce.number().int().min(1).max(10_000).default(200),
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
  /**
   * Claude model that reads a page chart's axis labels from a screenshot (POST /chart/calibrate, budget "other"):
   * Haiku by default; claude-sonnet-4-5 if Haiku's calibration error is too high; Opus refused unless ALLOW_OPUS.
   */
  CHART_VISION_MODEL: z.string().optional().or(z.literal("").transform(() => undefined)),
  /** Chart-calibration vision calls a UTC day (POST /chart/calibrate); past it, the extension lays Glance's lens over the chart. */
  CHART_VISION_DAILY_LIMIT: z.coerce.number().int().min(0).default(20),
  /** Robinhood Chain mainnet, read-only: the Chainlink feeds behind the price charts (GET /chart). */
  RPC_MAINNET_URL: z.url().default("https://rpc.mainnet.chain.robinhood.com"),
  CHART_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  /** Per-IP limits for the new read endpoints. */
  WHY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  PORTFOLIO_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  /**
   * Hosting: one directory for everything the API keeps (voice cache and pre-recorded lines, daily counters, the LLM
   * budget and name cache, sessions, the faucet ledger, chart rounds, the refusal log, the keeper's lock and pause
   * file). Mount a persistent volume here. Unset: apps/api/.cache as before.
   */
  DATA_DIR: z.string().optional().or(z.literal("").transform(() => undefined)),
  /** Where RESOLVER_CACHE_FILE defaults to (DATA_DIR when that is set), relative to this package. */
  LLM_CACHE_DIR: z.string().default(resolve(import.meta.dirname, "../.cache")),
  /**
   * "1": the API runs the feed keeper itself (mirroring mainnet feeds onto the testnet stand-ins every
   * KEEPER_INTERVAL_MS), one instance at a time (a lock in DATA_DIR). Needs KEEPER_PRIVATE_KEY (the feeds' owner).
   */
  KEEPER_IN_PROCESS: z
    .string()
    .optional()
    .transform((v) => v === "1"),
  KEEPER_INTERVAL_MS: z.coerce.number().int().min(15_000).default(30_000),
  /** The testnet feeds' owner key (not the agent key: two senders on one key would fight over nonces). */
  KEEPER_PRIVATE_KEY: z
    .string()
    .optional()
    .or(z.literal("").transform(() => undefined))
    .refine((v) => v === undefined || /^0x[0-9a-fA-F]{64}$/.test(v), "KEEPER_PRIVATE_KEY must be 0x followed by 64 hex characters"),
  /** "fake": simulated transcription and speech, for testing the voice path without keys (refused in production). */
  VOICE_PROVIDERS: z.enum(["auto", "fake"]).default("auto"),
  VOICE_FAKE_TRANSCRIPT: z.string().optional(),
  VOICE_FAKE_DELAY_MS: z.coerce.number().int().min(0).max(10_000).optional(),
  /** Comma separated. Chrome extension origins look like chrome-extension://<id>. */
  /**
   * The only browser origins allowed to call the API (comma separated): the extension (its fixed ID) and the console.
   * CORS is not authentication (anything outside a browser ignores it): that's why trades are signed.
   */
  CORS_ORIGINS: z
    .string()
    .optional()
    // Empty (as in a copied .env.example) means the default, not "no origins".
    .transform((v) => (v?.trim() ? v : "chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl,http://localhost:3000")),
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
  /** Linked browser sessions (JSON). Default .cache/sessions.json; memory only in tests unless set; "" for memory. */
  SESSION_STORE_FILE: z.string().optional(),
  SESSION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  /**
   * Vaults anyone may trade without a linked browser (comma separated). Empty by default: every vault needs its owner's
   * linked browser. For recording day only; their on-chain caps still apply, and each visitor is limited per hour.
   */
  OPEN_DEMO_VAULTS: z
    .string()
    .default("")
    .refine((v) => v.split(",").map((a) => a.trim()).filter(Boolean).every((a) => /^0x[0-9a-fA-F]{40}$/.test(a)), "OPEN_DEMO_VAULTS must be comma-separated 0x addresses"),
  DEMO_TRADES_PER_HOUR: z.coerce.number().int().min(0).default(10),
  /** Per-IP limits for voice (every /voice route and the audio stream) and for /resolve. */
  VOICE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  RESOLVE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  /**
   * Daily caps on paid voice, per UTC day: Deepgram speech-to-text seconds, and speech characters (pre-recorded lines
   * and phrases served from memory don't count). When one is used up: "Voice is resting for today. You can still type."
   */
  VOICE_STT_SECONDS_PER_DAY: z.coerce.number().int().min(0).default(1_800),
  /**
   * Speech recognition: AssemblyAI Universal-Streaming (the default) or Deepgram. With AssemblyAI, Deepgram is the
   * fallback on a connection error, an auth failure or a timeout, and once ASSEMBLYAI_STT_SECONDS_PER_DAY is used up.
   */
  STT_PROVIDER: z.enum(["assemblyai", "deepgram"]).default("assemblyai"),
  ASSEMBLYAI_API_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
  /** universal-3-5-pro (default: fastest, best on names) or universal-streaming-english. */
  ASSEMBLYAI_MODEL: z.string().default("universal-3-5-pro"),
  /** AssemblyAI streaming seconds a UTC day (billed as session time). */
  ASSEMBLYAI_STT_SECONDS_PER_DAY: z.coerce.number().int().min(0).default(3_600),
  /**
   * When an AssemblyAI session (billed from the moment it opens, held 5s for a stream to take) is opened ahead of time:
   * "panel" (default): when Glance's panel opens, and when ⌥V goes down; "key-down": only when ⌥V goes down (or
   * conversation mode starts). Measured 25 Sep: key-down only is ~155ms slower from key release to text (401 vs
   * 245ms median), because the session's 1.4s handshake overlaps the start of the command.
   */
  ASSEMBLYAI_WARM: z.enum(["panel", "key-down"]).default("panel"),
  /**
   * "1": this API serves live tests and benchmarks (scripts/stt-compare.ts): AssemblyAI seconds are counted under a
   * separate test counter that no daily cap reads. Refused in production.
   */
  VOICE_LIVE_TESTS: z
    .string()
    .optional()
    .transform((v) => v === "1"),
  VOICE_TTS_CHARS_PER_DAY: z.coerce.number().int().min(0).default(60_000),
  /** /health?admin=<ADMIN_TOKEN> shows the full view in production (agent balance, voice, budgets). Unset: never. */
  ADMIN_TOKEN: z
    .string()
    .min(16, "ADMIN_TOKEN must be at least 16 characters")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /**
   * "Get gas" on the console's Get started: a dedicated faucet wallet that sends 0.0005 test ETH to a new wallet
   * (src/faucet.ts). Unset: off (the console links the public faucet instead). Never logged, never returned.
   */
  FAUCET_PRIVATE_KEY: z
    .string()
    .regex(hexKey, "FAUCET_PRIVATE_KEY must be 0x followed by 64 hex characters")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /** The starter USDG's total per UTC day, in whole USDG (20 per wallet: ten wallets a day at the default). */
  FAUCET_DAILY_USDG: z
    .string()
    .regex(/^\d+$/, "FAUCET_DAILY_USDG must be a whole number like 200")
    .default("200"),
  /** The faucet's total per UTC day, in ETH. */
  FAUCET_DAILY_ETH: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "FAUCET_DAILY_ETH must be a decimal like 0.01")
    .default("0.01"),
  /** Shown by /health as versions.commit (set by the host, e.g. the deploy's git SHA). */
  GIT_COMMIT: z.string().optional(),
});

export type Config = z.infer<typeof envSchema> & { corsOrigins: string[]; openDemoVaults: `0x${string}`[] };

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
  const openDemoVaults = parsed.data.OPEN_DEMO_VAULTS.split(",")
    .map((a) => a.trim())
    .filter(Boolean) as `0x${string}`[];
  // DATA_DIR moves every persisted file under one directory (unless a path was set on its own).
  const data = parsed.data.DATA_DIR;
  const dataPaths = data
    ? {
        LLM_CACHE_DIR: env.LLM_CACHE_DIR ? parsed.data.LLM_CACHE_DIR : data,
        REFUSAL_LOG_FILE: parsed.data.REFUSAL_LOG_FILE ?? join(data, "refusals.jsonl"),
        KEEPER_PAUSE_FILE: env.KEEPER_PAUSE_FILE ? parsed.data.KEEPER_PAUSE_FILE : join(data, "keeper.paused"),
      }
    : {};
  return { ...parsed.data, ...dataPaths, corsOrigins, openDemoVaults };
}
