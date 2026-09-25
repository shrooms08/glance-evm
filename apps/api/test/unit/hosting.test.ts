/**
 * Hosting: DATA_DIR puts every persisted file under one directory (a volume), the in-process keeper starts only with
 * its own key (never the agent's) and logs writes, not routine skips, and /health/live answers at once for the host's
 * health check. No chain, no keys (fakes built at runtime).
 */
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { keeperLogLine, startInProcessKeeper } from "../../src/keeperInProcess.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const base = { NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" };
/** Two different fake keys (0x + 64 hex), made at runtime: never real, never key-shaped in the source. */
const FAKE_KEY_A = `0x${"a1".repeat(32)}`;
const FAKE_KEY_B = `0x${"b2".repeat(32)}`;

describe("DATA_DIR", () => {
  it("moves the cache, the refusal log and the keeper's pause file under it", () => {
    const c = loadConfig({ ...base, DATA_DIR: "/data" });
    expect(c.LLM_CACHE_DIR).toBe("/data");
    expect(c.REFUSAL_LOG_FILE).toBe(join("/data", "refusals.jsonl"));
    expect(c.KEEPER_PAUSE_FILE).toBe(join("/data", "keeper.paused"));
  });

  it("a path set on its own still wins; unset, everything stays where it was", () => {
    const c = loadConfig({ ...base, DATA_DIR: "/data", LLM_CACHE_DIR: "/elsewhere", REFUSAL_LOG_FILE: "" });
    expect(c.LLM_CACHE_DIR).toBe("/elsewhere");
    expect(c.REFUSAL_LOG_FILE).toBe("");
    const plain = loadConfig(base);
    expect(plain.DATA_DIR).toBeUndefined();
    expect(plain.LLM_CACHE_DIR).toMatch(/apps\/api\/\.cache$/);
  });

  it("the voice cache, meters, sessions and faucet ledger all live in the cache dir", () => {
    const ctx = createContext(loadConfig({ ...base, NODE_ENV: "development", DATA_DIR: "/tmp/glance-data-test", RESOLVER_CACHE_FILE: undefined }), () => {});
    expect(ctx.cacheDir).toBe("/tmp/glance-data-test");
  });
});

describe("the in-process keeper", () => {
  it("is off unless KEEPER_IN_PROCESS=1; 30s by default", () => {
    expect(loadConfig(base).KEEPER_IN_PROCESS).toBe(false);
    expect(loadConfig(base).KEEPER_INTERVAL_MS).toBe(30_000);
    expect(startInProcessKeeper(loadConfig(base), () => {})).toBeNull();
  });

  it("says why it isn't running: no key, or the agent's own key (trades and feed writes would fight over nonces)", () => {
    const lines: string[] = [];
    expect(startInProcessKeeper(loadConfig({ ...base, KEEPER_IN_PROCESS: "1" }), (l) => lines.push(l))).toBeNull();
    expect(startInProcessKeeper(loadConfig({ ...base, KEEPER_IN_PROCESS: "1", AGENT_PRIVATE_KEY: FAKE_KEY_A, KEEPER_PRIVATE_KEY: FAKE_KEY_A }), (l) => lines.push(l))).toBeNull();
    expect(lines).toEqual([
      "[keeper] KEEPER_IN_PROCESS=1 but KEEPER_PRIVATE_KEY is not set: the keeper is not running",
      "[keeper] KEEPER_PRIVATE_KEY is the agent key: refusing to run (trades and feed writes would fight over nonces)",
    ]);
    expect(lines.join()).not.toContain(FAKE_KEY_A.slice(2, 10));
  });

  it("a malformed key is refused by the config, without echoing it", () => {
    expect(() => loadConfig({ ...base, KEEPER_PRIVATE_KEY: "0x1234" })).toThrow(/KEEPER_PRIVATE_KEY must be 0x followed by 64 hex characters/);
    expect(loadConfig({ ...base, KEEPER_PRIVATE_KEY: FAKE_KEY_B }).KEEPER_PRIVATE_KEY).toBe(FAKE_KEY_B);
  });

  it("logs writes, errors, retries and RPC switches; not the routine skips or the per-pass summary", () => {
    expect(keeperLogLine("TSLA  mainnet-mirror: wrote $380.12 updated 2026-09-25T14:00:00Z (1m ago) from mainnet feed 0xabc, tx 0xdef")).toBe(true);
    expect(keeperLogLine("AMD   mainnet-mirror: ERROR rpc down")).toBe(true);
    expect(keeperLogLine("nonce error on the primary RPC (x), re-reading the pending nonce, retry 1/3")).toBe(true);
    expect(keeperLogLine("primary RPC unreachable (x), using the fallback RPC for the rest of this run")).toBe(true);
    expect(keeperLogLine("TSLA  mainnet-mirror: unchanged, skipped ($380)")).toBe(false);
    expect(keeperLogLine("NFLX  public-quote (yahoo-finance): held, market closed")).toBe(false);
    expect(keeperLogLine("summary: 1 written (TSLA), 6 unchanged (AMD, ...), 0 failed")).toBe(false);
  });
});

describe("/health/live", () => {
  it("answers at once with only ok (no chain calls, nothing about the setup)", async () => {
    const res = await createApp(createContext(loadConfig(base), () => {})).request("/health/live");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
