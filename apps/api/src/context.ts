/**
 * Everything a request handler needs, built once at startup.
 */
import type { Address, Chain, PublicClient } from "viem";

import { buildCatalog, loadCatalogText, type Catalog } from "./catalog.js";
import { chainFor, createChainClient } from "./chain.js";
import type { Config } from "./config.js";
import { desksOf, loadDeployment, type Deployment } from "./deployment.js";
import { createLlmResolver, type LlmResolver } from "./llm.js";
import { Resolver } from "./resolver.js";
import { loadAgentSigner, type AgentSigner } from "./signer.js";

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
}

export function createContext(config: Config): AppContext {
  const deployment = loadDeployment(config.DEPLOYMENT_FILE);
  const catalogText = loadCatalogText();
  const catalog = buildCatalog(deployment, catalogText);
  const chain = chainFor(deployment, config);
  return {
    config,
    deployment,
    catalog,
    chain,
    client: createChainClient(chain, config.RPC_URL),
    signer: loadAgentSigner(config.AGENT_PRIVATE_KEY, chain, config.RPC_URL),
    resolver: new Resolver(catalog.text),
    llm: createLlmResolver(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL, catalog.text),
    desks: desksOf(deployment),
  };
}
