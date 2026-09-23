import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Glance API on http://localhost:${info.port}`);
  console.log(`  chain ${ctx.deployment.chainId} via ${config.RPC_URL}`);
  console.log(`  deployment ${config.DEPLOYMENT_FILE}`);
  console.log(`  agent key ${ctx.signer ? `loaded (${ctx.signer.account.address})` : "not loaded: /trade disabled"}`);
  console.log(`  LLM resolver fallback ${ctx.llm ? `on (${config.ANTHROPIC_MODEL})` : "off"}`);
});
