/**
 * "Get gas": only for a wallet under 0.0002 ETH, once per address ever (surviving a restart), 5 an hour per IP, within
 * the daily total; nonces assigned locally and re-read on a nonce error; addresses never in the log; off (and hidden)
 * without FAUCET_PRIVATE_KEY. A fake chain: nothing is sent.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseEther, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { createFaucet, FAUCET_AMOUNT, JsonFaucetStore, type FaucetChain } from "../../src/faucet.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const NOW = Date.parse("2026-09-24T12:00:00Z");
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

function chain(o: { balances?: Record<string, bigint>; failures?: Record<number, string> } = {}) {
  let accountNonce = 7;
  let sends = 0;
  const sent: Array<{ to: Address; value: bigint; nonce: number }> = [];
  const c: FaucetChain = {
    balanceOf: async (a) => o.balances?.[a.toLowerCase()] ?? 0n,
    pendingNonce: vi.fn(async () => accountNonce),
    transfer: async (to, value, nonce) => {
      sends++;
      const f = o.failures?.[sends];
      if (f) throw new Error(f);
      if (nonce !== accountNonce) throw new Error(`nonce too low: ${nonce} vs ${accountNonce}`);
      accountNonce++;
      sent.push({ to, value, nonce });
      return `0x${sends.toString(16).padStart(64, "0")}` as Hex;
    },
  };
  return { c, sent };
}

const faucet = (o: { chain?: FaucetChain; store?: JsonFaucetStore; daily?: string; log?: string[]; now?: () => number } = {}) =>
  createFaucet({ chain: o.chain ?? chain().c, store: o.store ?? new JsonFaucetStore(null), dailyCap: parseEther(o.daily ?? "0.01"), now: o.now ?? (() => NOW), log: (l) => o.log?.push(l), sleep: async () => {} });

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "sent";
  } catch (err) {
    return (err as { code: string }).code;
  }
};

describe("who gets gas", () => {
  it("a wallet under 0.0002 ETH gets 0.0005 ETH; one that has gas doesn't", async () => {
    const f = chain({ balances: { [addr(2).toLowerCase()]: parseEther("0.0003") } });
    const x = faucet({ chain: f.c });
    expect(await x.gas({ address: addr(1), ip: "198.51.100.1" })).toMatchObject({ amountEth: "0.0005" });
    expect(f.sent[0]).toMatchObject({ to: addr(1), value: FAUCET_AMOUNT });
    expect(await code(x.gas({ address: addr(2), ip: "198.51.100.1" }))).toBe("FAUCET_HAS_GAS");
  });

  it("once per address, ever (a restart remembers)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "glance-faucet-")), "faucet.json");
    expect(await code(faucet({ store: new JsonFaucetStore(file) }).gas({ address: addr(1), ip: "198.51.100.1" }))).toBe("sent");
    expect(await code(faucet({ store: new JsonFaucetStore(file) }).gas({ address: addr(1), ip: "198.51.100.2" }))).toBe("FAUCET_ALREADY_SENT");
  });

  it("5 an hour per IP", async () => {
    const x = faucet({ daily: "1" });
    for (let i = 1; i <= 5; i++) expect(await code(x.gas({ address: addr(i), ip: "203.0.113.9" }))).toBe("sent");
    expect(await code(x.gas({ address: addr(6), ip: "203.0.113.9" }))).toBe("FAUCET_BUSY");
    expect(await code(x.gas({ address: addr(6), ip: "203.0.113.10" }))).toBe("sent");
  });

  it("within the daily total (default 0.01 ETH: twenty sends), reset the next UTC day", async () => {
    let now = NOW;
    const x = faucet({ daily: "0.001", now: () => now });
    expect(await code(x.gas({ address: addr(1), ip: "a" }))).toBe("sent");
    expect(await code(x.gas({ address: addr(2), ip: "b" }))).toBe("sent");
    expect(await code(x.gas({ address: addr(3), ip: "c" }))).toBe("FAUCET_EMPTY_TODAY");
    now += 86_400_000;
    expect(await code(x.gas({ address: addr(3), ip: "c" }))).toBe("sent");
    expect(loadConfig({}).FAUCET_DAILY_ETH).toBe("0.01");
  });
});

describe("sending", () => {
  it("nonces are assigned locally (the pending nonce read once), one send at a time", async () => {
    const f = chain();
    const x = faucet({ chain: f.c, daily: "1" });
    await Promise.all([1, 2, 3].map((i) => x.gas({ address: addr(i), ip: `ip${i}` })));
    expect(f.sent.map((s) => s.nonce)).toEqual([7, 8, 9]);
    expect(f.c.pendingNonce).toHaveBeenCalledTimes(1);
  });

  it("a nonce error re-reads the pending nonce and retries", async () => {
    const f = chain({ failures: { 1: "nonce too low" } });
    expect(await code(faucet({ chain: f.c }).gas({ address: addr(1), ip: "a" }))).toBe("sent");
    expect(f.sent).toHaveLength(1);
  });

  it("a failed send isn't recorded (the wallet can ask again), and the log never shows an address or IP", async () => {
    const log: string[] = [];
    const f = chain({ failures: { 1: "insufficient funds", 2: "insufficient funds" } });
    const x = faucet({ chain: f.c, log });
    expect(await code(x.gas({ address: addr(1), ip: "198.51.100.77" }))).toBe("FAUCET_FAILED");
    const ok = chain();
    const y = faucet({ chain: ok.c, log });
    expect(await code(y.gas({ address: addr(1), ip: "198.51.100.77" }))).toBe("sent");
    const text = log.join("\n");
    expect(text).not.toContain(addr(1).slice(2));
    expect(text).not.toContain("198.51.100.77");
    expect(text).toMatch(/wallet [0-9a-f]{8}/);
  });
});

describe("off without FAUCET_PRIVATE_KEY", () => {
  it("GET /faucet says so (the console hides Get gas), and POST /faucet/gas is 404", async () => {
    const app = createApp(createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {}));
    expect(await (await app.request("/faucet")).json()).toEqual({ enabled: false, amountEth: null });
    const res = await app.request("/faucet/gas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: addr(1) }) });
    expect(res.status).toBe(404);
  });
});
