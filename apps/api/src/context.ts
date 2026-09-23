/**
 * Everything a request handler needs, built once at startup.
 */
import { getAddress, type Address, type Chain, type PublicClient } from "viem";

import { buildCatalog, loadCatalogText, loadPriceSources, type Catalog } from "./catalog.js";
import { chainFor, createChainClient } from "./chain.js";
import type { Config } from "./config.js";
import { desksOf, loadDeployment, primaryVault, type Deployment } from "./deployment.js";
import { createLlmResolver, type LlmResolver } from "./llm.js";
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
  /** Trades the guards refused before anything was sent (see src/refusals.ts). */
  refusals: RefusalLog;
}

export function createContext(config: Config): AppContext {
  const deployment = loadDeployment(config.DEPLOYMENT_FILE);
  const catalogText = loadCatalogText();
  const catalog = buildCatalog(deployment, catalogText, loadPriceSources(config.PRICE_SOURCES_FILE));
  const chain = chainFor(deployment, config);
  return {
    config,
    deployment,
    catalog,
    chain,
    client: createChainClient(chain, rpcUrls(config)),
    signer: loadAgentSigner(config.AGENT_PRIVATE_KEY, chain, rpcUrls(config)),
    resolver: new Resolver(catalog.text),
    llm: createLlmResolver(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL, catalog.text),
    desks: desksOf(deployment),
    defaultVault: config.DEFAULT_VAULT ? getAddress(config.DEFAULT_VAULT) : primaryVault(deployment).address,
    voice: selectVoiceProviders(config),
    refusals: new RefusalLog(refusalLogFile(config)),
    intentModel: looksLikePlaceholder(config.ANTHROPIC_API_KEY) ? null : createClaudeIntent(config.ANTHROPIC_API_KEY, config.INTENT_MODEL, catalog.entries),
  };
}

/** data/refusals.jsonl by default; memory only in tests (unless set) or when set to "". */
function refusalLogFile(config: Config): string | null {
  const set = config.REFUSAL_LOG_FILE;
  if (set !== undefined) return set.trim() || null;
  return config.NODE_ENV === "test" ? null : "data/refusals.jsonl";
}
