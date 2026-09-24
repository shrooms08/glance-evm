/**
 * The starter fund: gas (0.0005 ETH, for a wallet under 0.0002) and 20 Paxos USDG (for a wallet under 5), each once per
 * address ever (surviving a restart), 5 an hour per IP, within its daily total; FAUCET_EMPTY in plain words when the
 * faucet wallet runs low; nonces assigned locally, one send at a time, re-read on a nonce error; addresses and IPs never
 * in the log; off without FAUCET_PRIVATE_KEY. A fake chain: nothing is sent.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseEther, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { createFaucet, EMPTY_GAS, EMPTY_USDG, FAUCET_AMOUNT, JsonFaucetStore, type FaucetChain } from "../../src/faucet.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const NOW = Date.parse("2026-09-24T12:00:00Z");
const FAUCET = "0xDadF016bA249283Ec3b779503C6814cE4D5844E2" as Address;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const usdg = (whole: number) => BigInt(whole) * 1_000_000n;

function chain(o: { eth?: Record<string, bigint>; usdg?: Record<string, bigint>; failures?: Record<number, string> } = {}) {
  let accountNonce = 7;
  let sends = 0;
  const sent: Array<{ kind: "gas" | "usdg"; to: Address; value: bigint; nonce: number }> = [];
  const eth = { [FAUCET.toLowerCase()]: parseEther("1"), ...o.eth };
  const tokens = { [FAUCET.toLowerCase()]: usdg(1_000), ...o.usdg };
  const move = (kind: "gas" | "usdg") => async (to: Address, value: bigint, nonce: number) => {
    sends++;
    const f = o.failures?.[sends];
    if (f) throw new Error(f);
    if (nonce !== accountNonce) throw new Error(`nonce too low: ${nonce} vs ${accountNonce}`);
    accountNonce++;
    sent.push({ kind, to, value, nonce });
    return `0x${sends.toString(16).padStart(64, "0")}` as Hex;
  };
  const c: FaucetChain = {
    address: FAUCET,
    balanceOf: async (a) => eth[a.toLowerCase()] ?? 0n,
    usdgBalanceOf: async (a) => tokens[a.toLowerCase()] ?? 0n,
    usdgDecimals: async () => 6,
    pendingNonce: vi.fn(async () => accountNonce),
    transfer: move("gas"),
    transferUsdg: move("usdg"),
  };
  return { c, sent };
}

const faucet = (o: { chain?: FaucetChain; store?: JsonFaucetStore; daily?: string; dailyUsdg?: string; log?: string[]; now?: () => number } = {}) =>
  createFaucet({
    chain: o.chain ?? chain().c,
    store: o.store ?? new JsonFaucetStore(null),
    dailyCap: parseEther(o.daily ?? "0.01"),
    dailyUsdg: o.dailyUsdg ?? "200",
    now: o.now ?? (() => NOW),
    log: (l) => o.log?.push(l),
    sleep: async () => {},
  });

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "sent";
  } catch (err) {
    return (err as { code: string }).code;
  }
};

describe("gas", () => {
  it("a wallet under 0.0002 ETH gets 0.0005 ETH; one that has gas doesn't", async () => {
    const f = chain({ eth: { [addr(2).toLowerCase()]: parseEther("0.0003") } });
    const x = faucet({ chain: f.c });
    expect(await x.gas({ address: addr(1), ip: "198.51.100.1" })).toMatchObject({ amountEth: "0.0005" });
    expect(f.sent[0]).toMatchObject({ kind: "gas", to: addr(1), value: FAUCET_AMOUNT });
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

  it("within the daily total, reset the next UTC day", async () => {
    let now = NOW;
    const x = faucet({ daily: "0.001", now: () => now });
    expect(await code(x.gas({ address: addr(1), ip: "a" }))).toBe("sent");
    expect(await code(x.gas({ address: addr(2), ip: "b" }))).toBe("sent");
    expect(await code(x.gas({ address: addr(3), ip: "c" }))).toBe("FAUCET_EMPTY_TODAY");
    now += 86_400_000;
    expect(await code(x.gas({ address: addr(3), ip: "c" }))).toBe("sent");
  });

  it("the faucet wallet out of ETH: FAUCET_EMPTY, in plain words", async () => {
    const x = faucet({ chain: chain({ eth: { [FAUCET.toLowerCase()]: parseEther("0.0004") } }).c });
    await expect(x.gas({ address: addr(1), ip: "a" })).rejects.toMatchObject({ code: "FAUCET_EMPTY", message: EMPTY_GAS });
  });
});

describe("starter USDG", () => {
  it("a wallet under 5 USDG gets 20 Paxos USDG; one with 5 or more doesn't", async () => {
    const f = chain({ usdg: { [addr(2).toLowerCase()]: usdg(5) } });
    const x = faucet({ chain: f.c });
    expect(await x.usdg({ address: addr(1), ip: "198.51.100.1" })).toMatchObject({ amountUsdg: "20" });
    expect(f.sent[0]).toMatchObject({ kind: "usdg", to: addr(1), value: usdg(20) });
    expect(await code(x.usdg({ address: addr(2), ip: "198.51.100.1" }))).toBe("FAUCET_HAS_USDG");
  });

  it("once per address, ever (kept apart from gas: a wallet gets both, once each)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "glance-faucet-")), "faucet.json");
    const f = chain();
    expect(await code(faucet({ chain: f.c, store: new JsonFaucetStore(file) }).gas({ address: addr(1), ip: "a" }))).toBe("sent");
    expect(await code(faucet({ chain: f.c, store: new JsonFaucetStore(file) }).usdg({ address: addr(1), ip: "a" }))).toBe("sent");
    expect(await code(faucet({ chain: f.c, store: new JsonFaucetStore(file) }).usdg({ address: addr(1), ip: "b" }))).toBe("FAUCET_ALREADY_SENT");
  });

  it("5 an hour per IP, and the daily total (FAUCET_DAILY_USDG, default 200: ten wallets)", async () => {
    const x = faucet({ dailyUsdg: "1000" });
    for (let i = 1; i <= 5; i++) expect(await code(x.usdg({ address: addr(i), ip: "203.0.113.9" }))).toBe("sent");
    expect(await code(x.usdg({ address: addr(6), ip: "203.0.113.9" }))).toBe("FAUCET_BUSY");
    const y = faucet({ dailyUsdg: "40" });
    expect(await code(y.usdg({ address: addr(1), ip: "a" }))).toBe("sent");
    expect(await code(y.usdg({ address: addr(2), ip: "b" }))).toBe("sent");
    expect(await code(y.usdg({ address: addr(3), ip: "c" }))).toBe("FAUCET_EMPTY_TODAY");
    expect(loadConfig({}).FAUCET_DAILY_USDG).toBe("200");
  });

  it("the faucet wallet out of USDG (or of gas to send it): FAUCET_EMPTY, 'Claim from the Paxos faucet instead.'", async () => {
    const low = faucet({ chain: chain({ usdg: { [FAUCET.toLowerCase()]: usdg(19) } }).c });
    await expect(low.usdg({ address: addr(1), ip: "a" })).rejects.toMatchObject({ code: "FAUCET_EMPTY", message: EMPTY_USDG });
    expect(EMPTY_USDG).toBe("Our starter fund is empty right now. Claim from the Paxos faucet instead.");
    const noGas = faucet({ chain: chain({ eth: { [FAUCET.toLowerCase()]: 0n } }).c });
    expect(await code(noGas.usdg({ address: addr(1), ip: "a" }))).toBe("FAUCET_EMPTY");
    expect(await low.stock()).toEqual({ gas: true, usdg: false });
  });
});

describe("sending", () => {
  it("gas and USDG share one line: nonces assigned locally (the pending nonce read once), one send at a time", async () => {
    const f = chain();
    const x = faucet({ chain: f.c, daily: "1" });
    await Promise.all([x.gas({ address: addr(1), ip: "a" }), x.usdg({ address: addr(1), ip: "a" }), x.gas({ address: addr(2), ip: "b" })]);
    expect(f.sent.map((s) => s.nonce)).toEqual([7, 8, 9]);
    expect(f.c.pendingNonce).toHaveBeenCalledTimes(1);
  });

  it("a nonce error re-reads the pending nonce and retries", async () => {
    const f = chain({ failures: { 1: "nonce too low" } });
    expect(await code(faucet({ chain: f.c }).usdg({ address: addr(1), ip: "a" }))).toBe("sent");
    expect(f.sent).toHaveLength(1);
  });

  it("a failed send isn't recorded (the wallet can ask again), and the log never shows an address or IP", async () => {
    const log: string[] = [];
    const f = chain({ failures: { 1: "insufficient funds", 2: "insufficient funds" } });
    expect(await code(faucet({ chain: f.c, log }).gas({ address: addr(1), ip: "198.51.100.77" }))).toBe("FAUCET_FAILED");
    expect(await code(faucet({ chain: chain().c, log }).gas({ address: addr(1), ip: "198.51.100.77" }))).toBe("sent");
    const text = log.join("\n");
    expect(text).not.toContain(addr(1).slice(2));
    expect(text).not.toContain("198.51.100.77");
    expect(text).toMatch(/wallet [0-9a-f]{8}/);
  });

  it("its status: balances and today's totals (for /health's admin view and make faucet-status)", async () => {
    const x = faucet();
    await x.gas({ address: addr(1), ip: "a" });
    await x.usdg({ address: addr(1), ip: "a" });
    expect(await x.status()).toMatchObject({ address: FAUCET, today: { eth: "0.0005", usdg: "20" }, caps: { eth: "0.01", usdg: "200" } });
  });
});

describe("off without FAUCET_PRIVATE_KEY", () => {
  it("GET /faucet says so (the console links the faucet sites), and both POSTs are 404", async () => {
    const app = createApp(createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {}));
    expect(await (await app.request("/faucet")).json()).toEqual({ enabled: false, amountEth: null, usdg: { enabled: false, amount: null }, stocked: { gas: false, usdg: false } });
    for (const path of ["/faucet/gas", "/faucet/usdg"]) {
      const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: addr(1) }) });
      expect(res.status).toBe(404);
    }
  });
});
