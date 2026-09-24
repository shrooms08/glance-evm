/**
 * The keeper's writes against a fake chain: nonces assigned locally (+1 per write, the pending nonce read once), a
 * nonce error re-reads the nonce and succeeds on retry, one feed failing for good doesn't stop the others, the exit
 * code, the summary line, and the move to the fallback RPC only when the primary can't be reached.
 */
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";

import { exitCodeFor, runOnce, summaryLine, type KeeperDeps, type KeeperSymbol } from "../../src/keeper.js";
import type { Round } from "../../src/mirror.js";
import { isNonceError, NonceSender, type ChainIO } from "../../src/sender.js";

const NOW = 1_790_000_000n;
const feed = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

/**
 * A fake chain: the account's nonce, and the transactions sent. `failures` makes a given send fail (by call number,
 * 1-based) with a message; `stalePending` is how far behind a lagging node's pending nonce is.
 */
function fakeChain(name: string, o: { nonce?: number; failures?: Record<number, string>; stalePending?: number; revert?: Set<Address> } = {}) {
  let accountNonce = o.nonce ?? 40;
  let sends = 0;
  let pendingReads = 0;
  const sent: Array<{ feed: Address; nonce: number }> = [];
  const io: ChainIO = {
    name,
    pendingNonce: async () => {
      pendingReads++;
      if (o.failures?.[-pendingReads]) throw new Error(o.failures[-pendingReads]);
      return accountNonce - (pendingReads === 1 ? (o.stalePending ?? 0) : 0);
    },
    send: async (f, _round, nonce) => {
      sends++;
      const failure = o.failures?.[sends];
      if (failure) throw new Error(failure);
      if (nonce < accountNonce) throw new Error(`Nonce provided for the transaction (${nonce}) is lower than the current nonce of the account (${accountNonce})`);
      if (nonce > accountNonce) throw new Error(`nonce gap: ${nonce} after ${accountNonce}`);
      accountNonce++;
      sent.push({ feed: f, nonce });
      return `0x${sends.toString(16).padStart(64, "0")}` as Hex;
    },
    receipt: async (hash) => (o.revert && sent.find((_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}` === hash && o.revert!.has(sent[i]!.feed)) ? "reverted" : "success"),
  };
  return { io, sent, pendingReads: () => pendingReads };
}

const noSleep = async () => {};

function deps(symbols: string[], sender: NonceSender, lines: string[], readFails: Set<string> = new Set()): KeeperDeps {
  const list: KeeperSymbol[] = symbols.map((symbol, i) => ({ symbol, testnetFeed: feed(i + 1), source: { kind: "mainnet-mirror", feed: feed(100 + i) } as KeeperSymbol["source"] }));
  return {
    symbols: list,
    log: (l) => lines.push(l),
    readMainnet: async (f) => {
      const s = list.find((x) => x.source.kind === "mainnet-mirror" && x.source.feed === f)!.symbol;
      if (readFails.has(s)) throw new Error("mainnet read failed");
      return { answer: 100_00000000n + BigInt(s.length), updatedAt: NOW - 60n };
    },
    readPublicQuote: async () => null,
    readTestnet: async (f) => (f === feed(symbols.indexOf("NFLX") + 1) ? { answer: 100_00000000n + 4n, updatedAt: NOW - 60n } : ({ answer: 1n, updatedAt: 1n } satisfies Round)),
    testnetNow: async () => NOW,
    startRun: () => sender.startRun(),
    write: (f, r) => sender.write(f, r),
  };
}

describe("local nonces", () => {
  it("reads the pending nonce once, then +1 per write, strictly one after another", async () => {
    const chain = fakeChain("primary", { nonce: 40 });
    const sender = new NonceSender(chain.io, null, { log: () => {}, sleep: noSleep });
    const lines: string[] = [];
    const results = await runOnce(deps(["AMD", "AMZN", "PLTR", "TSLA"], sender, lines));
    expect(results.map((r) => r.plan)).toEqual(["write", "write", "write", "write"]);
    expect(chain.sent.map((s) => s.nonce)).toEqual([40, 41, 42, 43]);
    expect(chain.pendingReads()).toBe(1);
  });

  it("run #7: a lagging node's nonce is too low: re-read, wait, and the feed is written on retry", async () => {
    const chain = fakeChain("primary", { nonce: 40, failures: { 4: "Nonce provided is lower than the current nonce of the account" } });
    const sleeps: number[] = [];
    const lines: string[] = [];
    const sender = new NonceSender(chain.io, null, { log: (l) => lines.push(l), sleep: async (ms) => void sleeps.push(ms) });
    const results = await runOnce(deps(["AMD", "AMZN", "PLTR", "TSLA"], sender, lines));
    expect(results.map((r) => r.plan)).toEqual(["write", "write", "write", "write"]); // TSLA succeeded on retry
    expect(chain.sent.map((s) => `${s.nonce}`)).toEqual(["40", "41", "42", "43"]);
    expect(chain.pendingReads()).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(lines.some((l) => /nonce error .* retry 1\/2/.test(l))).toBe(true);
    expect(exitCodeFor(results)).toBe(0);
  });

  it("a stale starting nonce is fixed by the first error's re-read", async () => {
    const chain = fakeChain("primary", { nonce: 40, stalePending: 2 });
    const sender = new NonceSender(chain.io, null, { log: () => {}, sleep: noSleep });
    const results = await runOnce(deps(["AMD", "TSLA"], sender, []));
    expect(results.map((r) => r.plan)).toEqual(["write", "write"]);
    expect(chain.sent.map((s) => s.nonce)).toEqual([40, 41]);
  });

  it("recognises every nonce error the nodes send", () => {
    for (const m of ["nonce too low", "Nonce provided for the transaction (5) is lower than the current nonce of the account (6)", "already known", "replacement transaction underpriced"]) {
      expect(isNonceError(new Error(m))).toBe(true);
      expect(isNonceError({ message: "Execution failed", cause: { details: m } })).toBe(true);
    }
    expect(isNonceError(new Error("execution reverted"))).toBe(false);
  });
});

describe("failure policy", () => {
  it("a feed that keeps failing (after 2 retries) is an error; the other feeds are still written; exit 1", async () => {
    const chain = fakeChain("primary", { nonce: 7, failures: { 2: "nonce too low", 3: "nonce too low", 4: "nonce too low" } });
    const sender = new NonceSender(chain.io, null, { log: () => {}, sleep: noSleep });
    const lines: string[] = [];
    const results = await runOnce(deps(["AMD", "AMZN", "NFLX", "TSLA"], sender, lines));
    expect(results.map((r) => `${r.symbol}:${r.plan}`)).toEqual(["AMD:write", "AMZN:error", "NFLX:skip", "TSLA:write"]);
    expect(chain.sent.map((s) => s.nonce)).toEqual([7, 8]);
    expect(lines.some((l) => l.startsWith("AMZN") && l.includes("ERROR nonce too low"))).toBe(true);
    expect(exitCodeFor(results)).toBe(1);
    expect(lines.at(-1)).toBe("summary: 2 written (AMD, TSLA), 1 unchanged (NFLX), 1 failed (AMZN)");
  });

  it("a revert is never retried; a failed read fails only its own feed", async () => {
    const chain = fakeChain("primary", { revert: new Set([feed(1)]) });
    const sender = new NonceSender(chain.io, null, { log: () => {}, sleep: noSleep });
    const results = await runOnce(deps(["AMD", "AMZN", "TSLA"], sender, [], new Set(["AMZN"])));
    expect(results.map((r) => r.plan)).toEqual(["error", "error", "write"]);
    expect(chain.sent).toHaveLength(2); // AMD once (no retry), TSLA
  });

  it("exit code: 0 when nothing failed, whatever was written or skipped", () => {
    expect(exitCodeFor([{ symbol: "AMD", plan: "write" }, { symbol: "NFLX", plan: "skip" }, { symbol: "X", plan: "hold" }])).toBe(0);
    expect(exitCodeFor([{ symbol: "AMD", plan: "write" }, { symbol: "TSLA", plan: "error" }])).toBe(1);
    expect(exitCodeFor([])).toBe(0);
  });

  it("the summary line", () => {
    expect(summaryLine([{ symbol: "AMD", plan: "write" }, { symbol: "NFLX", plan: "hold" }, { symbol: "PLTR", plan: "skip" }])).toBe("summary: 1 written (AMD), 2 unchanged (NFLX, PLTR), 0 failed");
  });
});

describe("one RPC per run", () => {
  it("stays on the primary for nonce errors; moves to the fallback only when the primary is unreachable, for the rest of the run", async () => {
    const primary = fakeChain("primary", { nonce: 10, failures: { 2: "HTTP request failed. Details: fetch failed" } });
    const backup = fakeChain("fallback", { nonce: 11 }); // the same account, seen through the other RPC
    const lines: string[] = [];
    const sender = new NonceSender(primary.io, backup.io, { log: (l) => lines.push(l), sleep: noSleep });
    const results = await runOnce(deps(["AMD", "AMZN", "TSLA"], sender, lines));
    expect(results.map((r) => r.plan)).toEqual(["write", "write", "write"]);
    expect(primary.sent.map((s) => s.nonce)).toEqual([10]);
    expect(backup.sent.map((s) => s.nonce)).toEqual([11, 12]);
    expect(lines.some((l) => l.includes("primary RPC unreachable") && l.includes("fallback"))).toBe(true);
    expect(sender.rpc).toBe("fallback");
    // The next run starts on the primary again.
    await sender.startRun();
    expect(sender.rpc).toBe("primary");
  });

  it("a nonce error never moves the run to the other RPC", async () => {
    const primary = fakeChain("primary", { failures: { 1: "nonce too low" } });
    const backup = fakeChain("fallback");
    const sender = new NonceSender(primary.io, backup.io, { log: () => {}, sleep: noSleep });
    await runOnce(deps(["AMD"], sender, []));
    expect(backup.sent).toHaveLength(0);
    expect(backup.pendingReads()).toBe(0);
  });
});
