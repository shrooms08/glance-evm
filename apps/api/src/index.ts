import { serve } from "@hono/node-server";

import { createServerApp } from "./app.js";
import { loadConfig } from "./config.js";
import { redactUrl, rpcUrls } from "./rpc.js";
import { createContext } from "./context.js";
import { assemblyaiBanner } from "./voice/dailyCaps.js";

const config = loadConfig();
const ctx = createContext(config);
const { app, injectWebSocket } = createServerApp(ctx);

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Glance API on http://localhost:${info.port}`);
  console.log(`  chain ${ctx.deployment.chainId} via ${rpcUrls(config).map(redactUrl).join(", then ")}`);
  console.log(`  deployment ${config.DEPLOYMENT_FILE}`);
  console.log(`  agent key ${ctx.signer ? `loaded (${ctx.signer.account.address})` : "not loaded: /trade disabled"}`);
  const llm = ctx.llmBudget.status();
  console.log(`  LLM company lookup ${ctx.llm ? `on (${ctx.llmModels.resolver}, once per glance, names cached 7 days)` : "off"}`);
  console.log(`  LLM budget: ${llm.usedToday}/${llm.dailyLimit} Claude calls used today (UTC)${llm.paused ? `, paused until ${llm.pausedUntil}` : ""}`);
  console.log(`  LLM budgets per day: ${Object.entries(llm.byPurpose).map(([p, b]) => `${p} ${b.used}/${b.limit}`).join(", ")}`);
  // Which voice providers are active. Names and models only: keys are never logged.
  console.log(`  voice transcription: ${ctx.voice.status.transcription}`);
  if (ctx.voice.meters && ctx.voice.status.stt?.provider === "assemblyai") console.log(`  ${assemblyaiBanner(ctx.voice.meters)}`);
  console.log(`  voice speech:        ${ctx.voice.status.speech}`);
  console.log(`  voice speech chain:  ${ctx.voice.status.speechFallbacks}`);
  console.log(`  voice intent:        ${ctx.voice.status.intent}`);
  for (const w of ctx.voice.status.warnings) console.log(`  voice warning: ${w}`);
  if (ctx.prerecorded) console.log(`  voice pre-recorded: ${ctx.prerecorded.size} common lines in ${ctx.prerecorded.voice} (.cache/voice)`);
  // The common lines, recorded once in the configured voice (only the missing ones: a new voice records them all).
  if (ctx.prerecorded && ctx.voice.chain) void ctx.prerecorded.warm(ctx.voice.chain, (l) => console.log(l));
});
injectWebSocket(server);
