/**
 * Real AssemblyAI Universal-Streaming: the five spoken fixtures (test/fixtures/voice, a TTS voice) streamed in real time
 * with Glance's keyterms, each checked for the ticker and amount that matter. Opt-in: only with VOICE_LIVE_TESTS=1 and a
 * real ASSEMBLYAI_API_KEY, so the normal suite never touches the network or spends credit. One session per fixture,
 * 13s apart (the free tier opens 5 a minute).   pnpm --filter api test:voice-live
 * The medians against Deepgram come from scripts/stt-compare.ts, run against a running API.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { assemblyai, DEFAULT_ASSEMBLYAI_MODEL } from "../../src/voice/assemblyai.js";
import { rulesIntent, validateIntent } from "../../src/voice/intent.js";
import { looksLikePlaceholder } from "../../src/voice/providers.js";
import { keyterms } from "../../src/voice/routes.js";
import { STT_CASES, wavPcm } from "../../scripts/stt-compare.js";

// Only these variables, read from apps/api/.env over the environment into a local object (never printed).
const LIVE = process.env.VOICE_LIVE_TESTS === "1";
const dotenv = resolve(import.meta.dirname, "../../.env");
const fromFile = LIVE && existsSync(dotenv) ? parseEnv(readFileSync(dotenv, "utf8")) : {};
const pick = (k: string) => process.env[k] || fromFile[k] || undefined;
const apiKey = pick("ASSEMBLYAI_API_KEY");
const model = pick("ASSEMBLYAI_MODEL") || DEFAULT_ASSEMBLYAI_MODEL;
const haveKey = LIVE && !looksLikePlaceholder(apiKey);

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!haveKey)(`AssemblyAI ${model} (live)`, () => {
  it.each(STT_CASES)("$say", async (c) => {
    const aai = assemblyai({ apiKey: apiKey!, model });
    const pcm = wavPcm(new Uint8Array(readFileSync(resolve(import.meta.dirname, `../fixtures/voice/${c.file}.wav`))));
    const live = aai.stream(keyterms(ctx));
    const audio = new Uint8Array([...new Uint8Array(9_600), ...pcm, ...new Uint8Array(8_000)]);
    const t0 = performance.now();
    for (let at = 0, i = 0; at < audio.length; at += 1_280, i++) {
      live.send(audio.subarray(at, at + 1_280));
      const wait = t0 + (i + 1) * 40 - performance.now();
      if (wait > 0) await sleep(wait);
    }
    const t = await live.finish();
    console.info(`[assemblyai live] ${c.file}: release to final ${t.timing?.releaseToFinalMs}ms, connect ${t.timing?.connectMs}ms`);
    const heard = validateIntent(rulesIntent(t.text, ctx.catalog.entries), t.text, ctx.catalog.entries);
    expect(heard.intent).toBe(c.expect.intent);
    if (c.expect.symbol !== undefined) expect(heard.symbol).toBe(c.expect.symbol);
    if (c.expect.amount !== undefined) expect(heard.amount).toBe(c.expect.amount);
    await sleep(13_000); // the free tier: 5 new sessions a minute
  }, 40_000);
});

describe.skipIf(haveKey)("AssemblyAI live tests", () => {
  it("skipped: run with VOICE_LIVE_TESTS=1 and ASSEMBLYAI_API_KEY in apps/api/.env", () => {});
});
