import { serve } from "@hono/node-server";

import { createServerApp } from "./app.js";
import { loadConfig } from "./config.js";
import { redactUrl, rpcUrls } from "./rpc.js";
import { createContext } from "./context.js";

const config = loadConfig();
const ctx = createContext(config);
const { app, injectWebSocket } = createServerApp(ctx);

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Glance API on http://localhost:${info.port}`);
  console.log(`  chain ${ctx.deployment.chainId} via ${rpcUrls(config).map(redactUrl).join(", then ")}`);
  console.log(`  deployment ${config.DEPLOYMENT_FILE}`);
  console.log(`  agent key ${ctx.signer ? `loaded (${ctx.signer.account.address})` : "not loaded: /trade disabled"}`);
  const llm = ctx.llmBudget.status();
  console.log(`  LLM resolver fallback ${ctx.llm ? `on (${ctx.llmModels.resolver})` : "off"}`);
  console.log(`  LLM budget: ${llm.usedToday}/${llm.dailyLimit} Claude calls used today (UTC)${llm.paused ? `, paused until ${llm.pausedUntil}` : ""}`);
  // Which voice providers are active. Names and models only: keys are never logged.
  console.log(`  voice transcription: ${ctx.voice.status.transcription}`);
  console.log(`  voice speech:        ${ctx.voice.status.speech}`);
  console.log(`  voice intent:        ${ctx.voice.status.intent}`);
  for (const w of ctx.voice.status.warnings) console.log(`  voice warning: ${w}`);
});
injectWebSocket(server);
