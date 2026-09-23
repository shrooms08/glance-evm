/**
 * When the testnet RPC isn't responding: reads retry with backoff and recover on their own, a trade is never retried,
 * and the chain status the panel shows follows what the API actually said.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("../lib/lifecycle", () => ({ send: (...a: unknown[]) => send(...a) }));

import { api, RPC_RETRY_DELAYS_MS, setSleepForTests } from "../lib/api";
import { chainStatus, onChainRecovered, resetChainStatusForTests } from "../lib/chainStatus";

const trouble = { ok: false, status: 503, code: "RPC_UNAVAILABLE", message: "The Robinhood Chain testnet isn't responding right now. Trying again…" };
const notVault = { ok: false, status: 404, code: "NOT_A_VAULT", message: "That address isn't a Glance vault." };
const vault = { ok: true, status: 200, data: { address: "0xabc" } };

describe("RPC trouble in the extension", () => {
  let slept: number[];
  beforeEach(() => {
    send.mockReset();
    resetChainStatusForTests();
    slept = [];
    setSleepForTests(async (ms) => void slept.push(ms));
  });

  it("retries a read with backoff and recovers on its own", async () => {
    send.mockResolvedValueOnce(trouble).mockResolvedValueOnce(trouble).mockResolvedValueOnce(vault);
    const res = await api.vault("0xabc");
    expect(res.ok).toBe(true);
    expect(slept).toEqual(RPC_RETRY_DELAYS_MS.slice(0, 2));
    expect(chainStatus()).toBe("ok");
  });

  it("after every retry, reports the testnet as not responding (never as not a vault)", async () => {
    send.mockResolvedValue(trouble);
    const res = await api.vault("0xabc");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe("RPC_UNAVAILABLE");
    expect(send).toHaveBeenCalledTimes(1 + RPC_RETRY_DELAYS_MS.length);
    expect(chainStatus()).toBe("trouble");
  });

  it("says 'not a vault' only when the chain answered that, without retrying", async () => {
    send.mockResolvedValue(notVault);
    const res = await api.vault("0xabc");
    expect(!res.ok && res.code).toBe("NOT_A_VAULT");
    expect(send).toHaveBeenCalledTimes(1);
    expect(chainStatus()).toBe("ok");
  });

  it("never retries a trade: it might already have gone through", async () => {
    send.mockResolvedValue(trouble);
    const res = await api.trade({ vault: "0xabc", symbol: "TSLA", side: "buy", amount: "5" });
    expect(!res.ok && res.code).toBe("RPC_UNAVAILABLE");
    expect(send).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("tells waiting views the moment the chain answers again", async () => {
    send.mockResolvedValue(trouble);
    await api.vault("0xabc");
    const recovered = vi.fn();
    onChainRecovered(recovered);
    send.mockResolvedValue({ ok: true, status: 200, data: {} });
    await api.health();
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(chainStatus()).toBe("ok");
  });
});
