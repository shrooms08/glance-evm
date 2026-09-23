/**
 * Refusals: what the guards stopped. Preflight refusals are recorded once (quotes repeat), survive a restart, and
 * belong to their vault; reverted transactions read from the explorer get the same sentences as everything else.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeErrorResult, getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { glanceVaultAbi } from "../../src/abi.generated.js";
import { attemptLabel, onChainRefusals, RefusalLog, type RefusalRecord } from "../../src/refusals.js";

const VAULT = getAddress("0xcafa07aca6c8b3efbf4638fd49e7beb42a0d0113");
const OTHER = getAddress("0xacfe90d34bb56222af06904a7547b6a9ac9aee2d");
const TSLA = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";

const refusal = (over: Partial<RefusalRecord> = {}): RefusalRecord => ({
  vault: VAULT,
  attempt: "Buy $150 of TSLA",
  symbol: "TSLA",
  side: "buy",
  amount: "$150",
  code: "PER_TRADE_CAP",
  error: "ExceedsPerTradeCap",
  message: "That's over your $100 per trade limit. Want me to buy $100 instead?",
  at: 1_790_000_000,
  via: "quote",
  ...over,
});

describe("RefusalLog", () => {
  it("records a refusal once, however often the same quote repeats, and keeps the confirm tap", () => {
    const log = new RefusalLog(null);
    expect(log.record(refusal())).toBe(true);
    expect(log.record(refusal({ at: 1_790_000_030 }))).toBe(false);
    expect(log.record(refusal({ at: 1_790_000_060, via: "trade" }))).toBe(false);
    expect(log.forVault(VAULT)).toHaveLength(1);
    expect(log.forVault(VAULT)[0]!.via).toBe("trade");
    // A different amount, reason, or ten minutes later is a new refusal.
    expect(log.record(refusal({ amount: "$200", attempt: "Buy $200 of TSLA" }))).toBe(true);
    expect(log.record(refusal({ at: 1_790_000_000 + 601 }))).toBe(true);
    expect(log.forVault(VAULT)).toHaveLength(3);
    expect(log.forVault(OTHER)).toHaveLength(0);
  });

  it("survives a restart, and a torn last line doesn't lose the rest", () => {
    const file = join(mkdtempSync(join(tmpdir(), "glance-refusals-")), "nested", "refusals.jsonl");
    const log = new RefusalLog(file);
    log.record(refusal());
    log.record(refusal({ vault: OTHER, code: "PAUSED", error: "VaultPaused", message: "Trading is paused on this vault." }));
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    const again = new RefusalLog(file);
    expect(again.persisted).toBe(true);
    expect(again.forVault(VAULT).map((r) => r.code)).toEqual(["PER_TRADE_CAP"]);
    expect(again.forVault(OTHER).map((r) => r.code)).toEqual(["PAUSED"]);
  });

  it("labels what was attempted", () => {
    expect(attemptLabel("buy", "TSLA", "$150")).toBe("Buy $150 of TSLA");
    expect(attemptLabel("sell", "TSLA", "0.5 TSLA")).toBe("Sell 0.5 TSLA");
  });
});

describe("reverted transactions from the explorer", () => {
  const agent = "0xa7078432F7Aa4db99F88cB181049872d1ea697a9";
  const raw = encodeErrorResult({ abi: glanceVaultAbi, errorName: "ExceedsPerTradeCap", args: [150_000_000n, 100_000_000n] });
  const notAgent = encodeErrorResult({ abi: glanceVaultAbi, errorName: "NotAgent", args: [agent] });
  const page = {
    items: [
      { hash: "0x01", result: "success", status: "ok", method: "buy", block_number: 5, timestamp: "2026-09-23T15:25:33Z", from: { hash: agent } },
      {
        hash: "0x02",
        result: "execution reverted",
        status: "error",
        method: "buy",
        block_number: 4,
        timestamp: "2026-09-23T15:00:00Z",
        from: { hash: agent },
        revert_reason: { raw },
        decoded_input: { method_call: "buy(address token, address router, uint256 usdgIn, uint256 minTokensOut)", parameters: [{ name: "token", value: TSLA }, { name: "usdgIn", value: "150000000" }] },
      },
      { hash: "0x03", status: "error", result: "execution reverted", method: "buy", block_number: 3, timestamp: "2026-09-23T14:00:00Z", from: { hash: "0x000000000000000000000000000000000000dEaD" }, revert_reason: { raw: notAgent } },
    ],
    next_page_params: null,
  };
  const fetchFn = (async (url: string) => {
    expect(url).toContain(`/api/v2/addresses/${VAULT}/transactions?filter=to`);
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof fetch;

  it("keeps only the failed ones, and explains each in the API's own words", async () => {
    const out = await onChainRefusals("https://explorer.example", VAULT, { usdgDecimals: 6, now: 1_790_200_000 }, fetchFn);
    expect(out.map((r) => r.txHash)).toEqual(["0x02", "0x03"]);
    expect(out[0]!.guard.code).toBe("PER_TRADE_CAP");
    expect(out[0]!.guard.message).toBe("That's over your $100 per trade limit. Want me to buy $100 instead?");
    expect(out[0]!.params.usdgIn).toBe("150000000");
    expect(out[0]!.timestamp).toBe(Date.parse("2026-09-23T15:00:00Z") / 1000);
    expect(out[1]!.guard.code).toBe("NOT_AGENT");
  });

  it("throws when the explorer can't be read, so no one mistakes that for 'no refusals'", async () => {
    const down = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    await expect(onChainRefusals("https://explorer.example", VAULT, { usdgDecimals: 6, now: 0 }, down)).rejects.toThrow("502");
  });
});
