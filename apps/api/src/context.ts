/**
 * Everything a request handler needs, built once at startup.
 */
import { dirname, join } from "node:path";

import { getAddress, type Address, type Chain, type PublicClient } from "viem";

import { buildCatalog, loadCatalogText, loadPriceSources, type Catalog } from "./catalog.js";
import { chainFor, createChainClient } from "./chain.js";
import type { Config } from "./config.js";
import { desksOf, loadDeployment, primaryVault, type Deployment } from "./deployment.js";
import type { ChartDeps } from "./chart.js";
import { createLlmResolver, type LlmResolver } from "./llm.js";
import { createShowMe, type ShowMe } from "./showme.js";
import { PrerecordedLines } from "./voice/prerecorded.js";
import { FIXED_LINES } from "@glance/core/persona";
import { chooseModel, LlmBudget, NameCache, type BudgetLimits, type Log } from "./llmBudget.js";
import { TtlCache } from "./ttlCache.js";
import { createFinnhub, createWhySummarizer, NEWS_TTL_MS, SUMMARY_TTL_MS, type NewsClient, type Summarizer, type WhyAnswer } from "./why.js";
import { RefusalLog } from "./refusals.js";
import { Resolver } from "./resolver.js";
import { rpcUrls } from "./rpc.js";
import { loadAgentSigner, type AgentSigner } from "./signer.js";
import { createClaudeIntent, type IntentModel } from "./voice/intent.js";
import { looksLikePlaceholder, selectVoiceProviders, type VoiceProviders } from "./voice/providers.js";

export interface AppContext {
  config: Config;
  deployment: Deployment;
  catalog: Catalog;
  chain: Chain;
  client: PublicClient;
  signer: AgentSigner | null;
  resolver: Resolver;
  llm: LlmResolver | null;
  desks: Address[];
  /** The vault used when a request names none: DEFAULT_VAULT, else the deployment's primary vault. */
  defaultVault: Address;
  /** Deepgram and Fish Audio, when configured (the extension falls back to the browser's speech APIs otherwise). */
  voice: VoiceProviders;
  /** Claude for voice intents, when ANTHROPIC_API_KEY is set; the validated rules parser otherwise. */
  intentModel: IntentModel | null;
  /** Every Claude call's budget: the daily limit, the pause after a budget error, and the models in use. */
  llmBudget: LlmBudget;
  llmModels: { resolver: string; intent: string; why: string; other: string };
  /** The common lines pre-recorded in the configured voice (src/voice/prerecorded.ts), when there's a speech provider. */
  prerecorded: PrerecordedLines | null;
  /** "Show me", teach and guide (POST /showme), when ANTHROPIC_API_KEY is set. */
  showMe: ShowMe | null;
  /** "Why it moved": Finnhub news (15-minute cache), the budgeted summarizer, and the 3-hour answer cache. */
  why: { news: NewsClient | null; summarizer: Summarizer | null; summaries: TtlCache<Omit<WhyAnswer, "cached">> };
  /** Trades the guards refused before anything was sent (see src/refusals.ts). */
  refusals: RefusalLog;
  /** Tests only: parts of the chart's sources to replace (a fake mainnet reader, fake quote history). */
  chartOverrides?: Partial<ChartDeps>;
  /** The gitignored .cache dir for persisted caches (portfolio events, news, names); null keeps them in memory (tests). */
  cacheDir: string | null;
}

/** The resolver cache and the call counter: files under LLM_CACHE_DIR by default; memory only in tests or when "". */
export function llmFiles(config: Config): { cache: string | null; usage: string | null } {
  const set = config.RESOLVER_CACHE_FILE;
  const cache = set !== undefined ? set.trim() || null : config.NODE_ENV === "test" ? null : join(config.LLM_CACHE_DIR, "resolver-names.json");
  return { cache, usage: cache ? join(dirname(cache), "llm-usage.json") : null };
}

export function createContext(config: Config, log: Log = (l) => console.log(l)): AppContext {
  const deployment = loadDeployment(config.DEPLOYMENT_FILE);
  const catalogText = loadCatalogText();
  const catalog = buildCatalog(deployment, catalogText, loadPriceSources(config.PRICE_SOURCES_FILE));
  const chain = chainFor(deployment, config);
  const models = {
    resolver: chooseModel(config.RESOLVER_MODEL ?? config.ANTHROPIC_MODEL, config.ALLOW_OPUS, "resolver", log),
    intent: chooseModel(config.INTENT_MODEL, config.ALLOW_OPUS, "intent", log),
    why: chooseModel(config.WHY_MODEL, config.ALLOW_OPUS, "why", log),
    other: chooseModel(config.SHOWME_MODEL, config.ALLOW_OPUS, "showme", log),
  };
  const files = llmFiles(config);
  const cacheDir = files.cache ? dirname(files.cache) : null;
  const anthropicKey = looksLikePlaceholder(config.ANTHROPIC_API_KEY) ? undefined : config.ANTHROPIC_API_KEY;
  const budget = new LlmBudget(budgetLimits(config), files.usage, log);
  const voice = selectVoiceProviders({ ...config, INTENT_MODEL: models.intent });
  return {
    config,
    deployment,
    catalog,
    chain,
    client: createChainClient(chain, rpcUrls(config)),
    signer: loadAgentSigner(config.AGENT_PRIVATE_KEY, chain, rpcUrls(config)),
    resolver: new Resolver(catalog.text),
    llm: createLlmResolver({
      apiKey: looksLikePlaceholder(config.ANTHROPIC_API_KEY) ? undefined : config.ANTHROPIC_API_KEY,
      model: models.resolver,
      catalog: catalog.text,
      budget,
      cache: new NameCache(files.cache),
      log,
    }),
    desks: desksOf(deployment),
    defaultVault: config.DEFAULT_VAULT ? getAddress(config.DEFAULT_VAULT) : primaryVault(deployment).address,
    // The status line names the model actually used (after the Opus guard), not the one configured.
    voice,
    prerecorded: voice.chain && voice.speech.chain[0] ? new PrerecordedLines(voice.speech.chain[0].voice, FIXED_LINES, cacheDir ? join(cacheDir, "voice") : null) : null,
    refusals: new RefusalLog(refusalLogFile(config)),
    intentModel: looksLikePlaceholder(config.ANTHROPIC_API_KEY)
      ? null
      : createClaudeIntent(config.ANTHROPIC_API_KEY, models.intent, catalog.entries, 3_000, { budget, log }),
    llmBudget: budget,
    llmModels: models,
    showMe: createShowMe({ apiKey: anthropicKey, model: models.other, budget, symbols: catalog.entries.map((e) => e.symbol), log }),
    cacheDir,
    why: {
      news: config.FINNHUB_API_KEY
        ? createFinnhub({ apiKey: config.FINNHUB_API_KEY, cache: new TtlCache(cacheDir ? join(cacheDir, "finnhub.json") : null, NEWS_TTL_MS) })
        : null,
      summarizer: createWhySummarizer({ apiKey: anthropicKey, model: models.why, budget, log }),
      summaries: new TtlCache(cacheDir ? join(cacheDir, "why.json") : null, SUMMARY_TTL_MS),
    },
  };
}

/** The total and the per-purpose daily budgets, from the environment. */
export function budgetLimits(config: Config): BudgetLimits {
  return {
    total: config.LLM_DAILY_CALL_LIMIT,
    perPurpose: { resolver: config.LLM_BUDGET_RESOLVER, intent: config.LLM_BUDGET_INTENT, why: config.LLM_BUDGET_WHY, other: config.LLM_BUDGET_OTHER },
  };
}

/** data/refusals.jsonl by default; memory only in tests (unless set) or when set to "". */
function refusalLogFile(config: Config): string | null {
  const set = config.REFUSAL_LOG_FILE;
  if (set !== undefined) return set.trim() || null;
  return config.NODE_ENV === "test" ? null : "data/refusals.jsonl";
}
