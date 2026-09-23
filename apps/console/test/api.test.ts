/** The console tells the API being down apart from the testnet being down, and only says "not a vault" when the chain did. */
import { describe, expect, it } from "vitest";

import { apiGet, ApiProblem, retryDelay, shouldRetry } from "../lib/api";

const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("apiGet", () => {
  it("classifies each failure", async () => {
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(apiGet("/vault/0x1", down)).rejects.toMatchObject({ kind: "unreachable" });
    const rpc = answer(503, { error: { code: "RPC_UNAVAILABLE", message: "The Robinhood Chain testnet isn't responding right now. Trying again…" } });
    await expect(apiGet("/vault/0x1", rpc)).rejects.toMatchObject({ kind: "rpc", message: "The Robinhood Chain testnet isn't responding right now. Trying again…" });
    await expect(apiGet("/vault/0x1", answer(404, { error: { code: "NOT_A_VAULT", message: "x isn't a Glance vault." } }))).rejects.toMatchObject({ kind: "not-a-vault" });
    await expect(apiGet("/vault/0x1", answer(400, { error: { code: "BAD_ADDRESS", message: "Not an address." } }))).rejects.toMatchObject({ kind: "other", code: "BAD_ADDRESS" });
    await expect(apiGet<{ ok: boolean }>("/health", answer(200, { ok: true }))).resolves.toEqual({ ok: true });
  });

  it("retries only while the testnet isn't responding, backing off", () => {
    expect(shouldRetry(0, new ApiProblem("rpc", "x"))).toBe(true);
    expect(shouldRetry(3, new ApiProblem("rpc", "x"))).toBe(false);
    expect(shouldRetry(0, new ApiProblem("not-a-vault", "x"))).toBe(false);
    expect([0, 1, 2, 5].map(retryDelay)).toEqual([1_000, 2_000, 4_000, 4_000]);
  });
});
