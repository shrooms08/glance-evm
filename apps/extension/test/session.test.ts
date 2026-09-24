/**
 * This browser's session key: made once and kept, never shown (only its address), forgotten on "Unlink this browser";
 * and trade requests signed with it: the exact body, a deadline under 60 seconds, a fresh 128-bit nonce each time.
 */
import { recoverTypedDataAddress } from "viem";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it } from "vitest";
import { bodyHash, MAX_REQUEST_SECONDS, SESSION_HEADERS, tradeTypedData } from "@glance/core/session";

import { forgetSession, resetSessionCacheForTests, sessionAddress, signTrade } from "../lib/session";

beforeEach(() => {
  fakeBrowser.reset();
  resetSessionCacheForTests();
});

describe("the session key", () => {
  it("is made once and kept in local storage (never sync); only its address is handed out", async () => {
    const a = await sessionAddress();
    resetSessionCacheForTests();
    expect(await sessionAddress()).toBe(a);
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(Object.keys(await fakeBrowser.storage.sync.get(null))).not.toContain("sessionPrivateKey");
    expect(Object.keys(await fakeBrowser.storage.local.get(null))).toContain("sessionPrivateKey");
  });

  it("'Unlink this browser' forgets it: the next link uses a new key", async () => {
    const a = await sessionAddress();
    await forgetSession();
    expect(await sessionAddress()).not.toBe(a);
  });
});

describe("signed trade requests", () => {
  const body = { vault: "0x1111111111111111111111111111111111111111", symbol: "TSLA", side: "buy" as const, amount: "10" };

  it("signs the exact body with the session key, a deadline under 60s, and a fresh nonce", async () => {
    const now = 1_790_000_000_000;
    const a = await signTrade(body, now);
    expect(a.raw).toBe(JSON.stringify(body));
    const deadline = Number(a.headers[SESSION_HEADERS.deadline]);
    expect(deadline - now / 1000).toBeGreaterThan(0);
    expect(deadline - now / 1000).toBeLessThanOrEqual(MAX_REQUEST_SECONDS);
    const nonce = BigInt(a.headers[SESSION_HEADERS.nonce]!);
    expect(nonce < 2n ** 128n).toBe(true);
    const signer = await recoverTypedDataAddress({
      ...tradeTypedData({ vault: body.vault as `0x${string}`, action: "trade", token: "TSLA", amount: "10", side: "buy", maxSlippageBps: 0, deadline: BigInt(deadline), requestNonce: nonce, bodyHash: bodyHash(a.raw) }),
      signature: a.headers[SESSION_HEADERS.signature] as `0x${string}`,
    });
    expect(signer).toBe(await sessionAddress());
    expect(a.headers[SESSION_HEADERS.session]).toBe(signer);
    const b = await signTrade(body, now);
    expect(b.headers[SESSION_HEADERS.nonce]).not.toBe(a.headers[SESSION_HEADERS.nonce]);
  });
});
