import { mkdirSync } from "node:fs";

import { serve } from "@hono/node-server";

import { createServerApp } from "./app.js";
import { loadConfig } from "./config.js";
import { redactUrl, rpcUrls } from "./rpc.js";
import { createContext } from "./context.js";
import { assemblyaiBanner } from "./voice/dailyCaps.js";
import { startInProcessKeeper } from "./keeperInProcess.js";

const config = loadConfig();
// A fresh volume may not have the directory yet: every store below writes into it.
if (config.DATA_DIR) mkdirSync(config.DATA_DIR, { recursive: true });
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
  console.log(`  data dir ${config.DATA_DIR ?? `${config.LLM_CACHE_DIR} (DATA_DIR unset)`}`);
  console.log(`  live prices: ${config.FINNHUB_API_KEY ? "Finnhub" : "Yahoo only (FINNHUB_API_KEY unset)"}, every 15s while the market is open; trades refused past ${config.LIVE_ORACLE_MAX_GAP_BPS} bps from the oracle`);
  const origins = config.corsOrigins;
  console.log(`  CORS origins: ${origins.join(", ") || "none"}`);
  if (config.NODE_ENV === "production") {
    if (!origins.some((o) => o.startsWith("chrome-extension://"))) console.log("  warning: CORS_ORIGINS has no chrome-extension:// origin: the extension can't call this API");
    if (/localhost|127\.0\.0\.1/.test(config.CORS_ORIGINS)) console.log("  note: CORS_ORIGINS lists localhost; it is dropped in production");
  }
  console.log(
    `  keeper: ${keeper ? `in-process every ${Math.round(config.KEEPER_INTERVAL_MS / 1000)}s (lock ${keeper.lockFile})` : config.KEEPER_IN_PROCESS ? "not running (see the [keeper] line)" : "not in this process (KEEPER_IN_PROCESS unset)"}`,
  );
  // The common lines, recorded once in the configured voice (only the missing ones: a new voice records them all).
  if (ctx.prerecorded && ctx.voice.chain) void ctx.prerecorded.warm(ctx.voice.chain, (l) => console.log(l));
});
injectWebSocket(server);

// Live market prices (display and the drift guard): Finnhub every 15s while the market is open, 5 minutes otherwise.
ctx.liveQuotes.start();

// The feed keeper in this process (KEEPER_IN_PROCESS=1): one instance at a time, never stopping the API.
const keeper = startInProcessKeeper(config);
ctx.keeperInProcess = keeper;

// A redeploy stops this container with SIGTERM: finish cleanly (the keeper's lock released for the next one).
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    keeper?.stop();
    ctx.liveQuotes.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
