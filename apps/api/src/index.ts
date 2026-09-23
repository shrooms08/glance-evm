import { serve } from "@hono/node-server";

import { createServerApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";

const config = loadConfig();
const ctx = createContext(config);
const { app, injectWebSocket } = createServerApp(ctx);

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Glance API on http://localhost:${info.port}`);
  console.log(`  chain ${ctx.deployment.chainId} via ${config.RPC_URL}`);
  console.log(`  deployment ${config.DEPLOYMENT_FILE}`);
  console.log(`  agent key ${ctx.signer ? `loaded (${ctx.signer.account.address})` : "not loaded: /trade disabled"}`);
  console.log(`  LLM resolver fallback ${ctx.llm ? `on (${config.ANTHROPIC_MODEL})` : "off"}`);
  // Which voice providers are active. Names and models only: keys are never logged.
  console.log(`  voice transcription: ${ctx.voice.status.transcription}`);
  console.log(`  voice speech:        ${ctx.voice.status.speech}`);
  console.log(`  voice intent:        ${ctx.voice.status.intent}`);
  for (const w of ctx.voice.status.warnings) console.log(`  voice warning: ${w}`);
});
injectWebSocket(server);
