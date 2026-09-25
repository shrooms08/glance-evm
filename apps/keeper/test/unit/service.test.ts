/**
 * The keeper as a service (for the API's KEEPER_IN_PROCESS=1): one instance at a time through a lock file (a second
 * waits, a dead one's stale lock is taken over, only the holder releases it), passes never overlap, the pause switch
 * stops writes, and a keeper that can't start is retried without stopping anything. No chain, no network.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KeeperLock, startKeeperLoop, type Keeper } from "../../src/service.ts";

const dir = () => mkdtempSync(join(tmpdir(), "glance-keeper-"));

describe("KeeperLock", () => {
  it("one holder at a time; the holder keeps it; release frees it for the next", () => {
    const file = join(dir(), "keeper.lock");
    const a = new KeeperLock(file, 60_000);
    const b = new KeeperLock(file, 60_000);
    expect(a.acquire()).toBe(true);
    expect(b.acquire()).toBe(false);
    expect(a.acquire()).toBe(true);
    b.release(); // not the holder: nothing happens
    expect(existsSync(file)).toBe(true);
    a.release();
    expect(existsSync(file)).toBe(false);
    expect(b.acquire()).toBe(true);
  });

  it("a lock nobody refreshed for staleMs (its instance died) is taken over", () => {
    const file = join(dir(), "keeper.lock");
    let now = Date.now();
    const dead = new KeeperLock(file, 60_000, () => now);
    expect(dead.acquire()).toBe(true);
    const next = new KeeperLock(file, 60_000, () => now);
    expect(next.acquire()).toBe(false);
    now += 61_000;
    expect(next.acquire()).toBe(true);
    expect(dead.acquire()).toBe(false); // it's not theirs any more
  });
});

describe("startKeeperLoop", () => {
  afterEach(() => vi.useRealTimers());
  const fakeKeeper = (runs: { n: number; active: number; maxActive: number }): Keeper => ({
    address: "0x1111111111111111111111111111111111111111",
    chainId: 46630,
    symbols: [],
    runOnce: async () => {
      runs.n++;
      runs.active++;
      runs.maxActive = Math.max(runs.maxActive, runs.active);
      await new Promise((r) => setTimeout(r, 50));
      runs.active--;
      return [];
    },
  });

  it("runs every interval while it holds the lock, never two passes at once, and logs how it started", async () => {
    vi.useFakeTimers();
    const d = dir();
    const runs = { n: 0, active: 0, maxActive: 0 };
    const lines: string[] = [];
    const loop = startKeeperLoop({ intervalMs: 1_000, lockFile: join(d, "keeper.lock"), pauseFile: join(d, "keeper.paused"), log: (l) => lines.push(l), create: async () => fakeKeeper(runs), env: {} });
    await vi.advanceTimersByTimeAsync(3_200); // passes at 0, 1.05, 2.10 and 3.15s (each takes 50ms, then the interval)
    expect(runs.n).toBe(4);
    expect(runs.maxActive).toBe(1);
    expect(loop.running()).toBe(true);
    expect(lines[0]).toMatch(/^keeper in-process: every 1s as 0x1111/);
    loop.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs.n).toBe(4);
    expect(existsSync(join(d, "keeper.lock"))).toBe(false);
  });

  it("a second instance waits while the first holds the lock (two keepers on one key would fight over nonces)", async () => {
    vi.useFakeTimers();
    const d = dir();
    const first = { n: 0, active: 0, maxActive: 0 };
    const second = { n: 0, active: 0, maxActive: 0 };
    const lines: string[] = [];
    const a = startKeeperLoop({ intervalMs: 1_000, lockFile: join(d, "keeper.lock"), pauseFile: join(d, "p"), log: () => {}, create: async () => fakeKeeper(first), env: {} });
    await vi.advanceTimersByTimeAsync(100);
    const b = startKeeperLoop({ intervalMs: 1_000, lockFile: join(d, "keeper.lock"), pauseFile: join(d, "p"), log: (l) => lines.push(l), create: async () => fakeKeeper(second), env: {} });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(first.n).toBeGreaterThan(0);
    expect(second.n).toBe(0);
    expect(lines).toEqual([expect.stringMatching(/another instance holds the lock/)]); // said once
    a.stop();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(second.n).toBeGreaterThan(0); // the lock was released: the second takes over
    b.stop();
  });

  it("the pause file stops writes (said once), and removing it resumes", async () => {
    vi.useFakeTimers();
    const d = dir();
    const pause = join(d, "keeper.paused");
    writeFileSync(pause, "");
    const runs = { n: 0, active: 0, maxActive: 0 };
    const lines: string[] = [];
    const loop = startKeeperLoop({ intervalMs: 1_000, lockFile: join(d, "keeper.lock"), pauseFile: pause, log: (l) => lines.push(l), create: async () => fakeKeeper(runs), env: {} });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(runs.n).toBe(0);
    expect(lines.filter((l) => l.startsWith("keeper paused"))).toHaveLength(1);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(pause);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(runs.n).toBe(1);
    expect(lines).toContain("keeper resumed");
    loop.stop();
  });

  it("a keeper that can't start (a wrong RPC, a feed it doesn't own) is retried later; nothing throws", async () => {
    vi.useFakeTimers();
    const d = dir();
    let attempts = 0;
    const runs = { n: 0, active: 0, maxActive: 0 };
    const lines: string[] = [];
    const loop = startKeeperLoop({
      intervalMs: 1_000,
      retryMs: 10_000,
      lockFile: join(d, "keeper.lock"),
      pauseFile: join(d, "p"),
      log: (l) => lines.push(l),
      create: async () => {
        if (++attempts === 1) throw new Error("TSLA: feed 0xabc is owned by 0xdef, not by the keeper key\nmore");
        return fakeKeeper(runs);
      },
      env: {},
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(lines[0]).toBe("keeper not started: TSLA: feed 0xabc is owned by 0xdef, not by the keeper key; trying again in 0 min");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(2);
    expect(runs.n).toBe(1);
    loop.stop();
  });
});
