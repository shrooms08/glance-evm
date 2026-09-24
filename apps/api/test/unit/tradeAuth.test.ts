/**
 * Signed trade requests: a request signed by a linked session passes; a bad signature, an expired deadline, a replayed
 * nonce and a changed body are each refused with their own code; a vault with no session is refused; the open demo
 * vault trades without one, limited per visitor. Fakes only: generated keys, a fake clock, no chain.
 */
import { resolve } from "node:path";

import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { bodyHash, SESSION_HEADERS, SESSION_MESSAGES, tradeTypedData } from "@glance/core/session";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { createTradeAuth } from "../../src/tradeAuth.js";
import type { SessionStatus } from "../../src/sessions.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const baseCtx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {});

const NOW = 1_790_000_000;
const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const DEMO = "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113" as Address;
const linked = privateKeyToAccount(generatePrivateKey());
const unlinked = privateKeyToAccount(generatePrivateKey());

function auth(o: { status?: (vault: Address, key: Address) => SessionStatus; now?: () => number; perHour?: number; log?: string[] } = {}) {
  return createTradeAuth({
    sessions: {
      status: o.status ?? ((_vault, key) => (key.toLowerCase() === linked.address.toLowerCase() ? { linked: true, expiresAt: NOW + 86_400, linkedAt: NOW } : { linked: false, reason: "unknown" })),
    },
    chainId: 46_630,
    openDemoVaults: [DEMO],
    demoTradesPerHour: o.perHour ?? 10,
    now: o.now ?? (() => NOW),
    log: (l) => o.log?.push(l),
  });
}

/** A signed request, as the extension makes it. */
async function signed(key: PrivateKeyAccount, body: { vault: Address; symbol: string; side: "buy" | "sell"; amount: string; slippageBps?: number }, o: { deadline?: number; nonce?: bigint } = {}) {
  const raw = JSON.stringify(body);
  const deadline = o.deadline ?? NOW + 30;
  const nonce = o.nonce ?? 0x1234n;
  const signature = await key.signTypedData(
    tradeTypedData({ vault: body.vault, action: "trade", token: body.symbol, amount: body.amount, side: body.side, maxSlippageBps: body.slippageBps ?? 0, deadline: BigInt(deadline), requestNonce: nonce, bodyHash: bodyHash(raw) }),
  );
  const headers: Record<string, string> = {
    [SESSION_HEADERS.session]: key.address,
    [SESSION_HEADERS.signature]: signature,
    [SESSION_HEADERS.deadline]: String(deadline),
    [SESSION_HEADERS.nonce]: `0x${nonce.toString(16)}`,
  };
  return { raw, fields: body, headers, header: (n: string) => headers[n], ip: "203.0.113.7" };
}

const trade = { vault: VAULT, symbol: "TSLA", side: "buy" as const, amount: "10" };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "passed";
  } catch (err) {
    return (err as { code: string }).code;
  }
}

describe("signed trade requests", () => {
  it("a request signed by a linked session passes", async () => {
    expect(await auth().check(await signed(linked, trade))).toEqual({ via: "session", session: linked.address });
  });

  it("a signature by any other key: BAD_SIGNATURE", async () => {
    const req = await signed(unlinked, trade);
    const forged = { ...req, header: (n: string) => (n === SESSION_HEADERS.session ? linked.address : req.headers[n]) };
    expect(await code(auth().check(forged))).toBe("BAD_SIGNATURE");
  });

  it("the body changed after signing (amount, or the raw bytes): BAD_SIGNATURE", async () => {
    const req = await signed(linked, trade);
    expect(await code(auth().check({ ...req, fields: { ...trade, amount: "1000" }, raw: JSON.stringify({ ...trade, amount: "1000" }) }))).toBe("BAD_SIGNATURE");
    expect(await code(auth().check({ ...req, raw: `${req.raw} ` }))).toBe("BAD_SIGNATURE");
  });

  it("a deadline that has passed: REPLAYED; one more than 60s ahead: BAD_SIGNATURE", async () => {
    expect(await code(auth().check(await signed(linked, trade, { deadline: NOW - 1 })))).toBe("REPLAYED");
    expect(await code(auth().check(await signed(linked, trade, { deadline: NOW + 600 })))).toBe("BAD_SIGNATURE");
  });

  it("the same request twice: the second is REPLAYED", async () => {
    const a = auth();
    const req = await signed(linked, trade);
    expect((await a.check(req)).via).toBe("session");
    expect(await code(a.check(req))).toBe("REPLAYED");
    // A new nonce is a new request.
    expect((await a.check(await signed(linked, trade, { nonce: 0x99n }))).via).toBe("session");
  });

  it("a forged request can't burn a real nonce", async () => {
    const a = auth();
    const real = await signed(linked, trade, { nonce: 0x77n });
    const forged = await signed(unlinked, trade, { nonce: 0x77n });
    expect(await code(a.check({ ...forged, header: (n: string) => (n === SESSION_HEADERS.session ? linked.address : forged.headers[n]) }))).toBe("BAD_SIGNATURE");
    expect((await a.check(real)).via).toBe("session");
  });

  it("no session, an unlinked one, a revoked one: SESSION_REQUIRED; an expired one: SESSION_EXPIRED", async () => {
    const noHeaders = { ...(await signed(linked, trade)), header: () => undefined };
    expect(await code(auth().check(noHeaders))).toBe("SESSION_REQUIRED");
    expect(await code(auth().check(await signed(unlinked, trade)))).toBe("SESSION_REQUIRED");
    expect(await code(auth({ status: () => ({ linked: false, reason: "revoked" }) }).check(await signed(linked, trade)))).toBe("SESSION_REQUIRED");
    expect(await code(auth({ status: () => ({ linked: false, reason: "expired", expiresAt: NOW - 5 }) }).check(await signed(linked, trade)))).toBe("SESSION_EXPIRED");
  });
});

describe("the open demo vault", () => {
  it("trades without a session, 10 an hour per visitor, logged", async () => {
    const log: string[] = [];
    let now = NOW;
    const a = auth({ log, now: () => now });
    const req = { raw: "{}", fields: { ...trade, vault: DEMO }, header: () => undefined, ip: "198.51.100.4" };
    for (let i = 1; i <= 10; i++) expect(await a.check(req)).toEqual({ via: "demo", used: i, limit: 10 });
    expect(await code(a.check(req))).toBe("DEMO_LIMIT");
    // Another visitor has their own allowance; an hour later it resets.
    expect((await a.check({ ...req, ip: "198.51.100.5" })).via).toBe("demo");
    now += 3_601;
    expect((await a.check(req)).via).toBe("demo");
    expect(log[0]).toMatch(/^\[demo\] open trade on demo vault 0xCafa…0113 from visitor [0-9a-f]{8} \(1\/10 this hour\)$/);
    expect(log.join("\n")).not.toContain("198.51.100.4"); // the IP itself isn't logged
  });

  it("a browser linked to the demo vault is checked like any other (a replay is still refused)", async () => {
    const a = auth();
    const req = await signed(linked, { ...trade, vault: DEMO });
    expect((await a.check(req)).via).toBe("session");
    expect(await code(a.check(req))).toBe("REPLAYED");
  });
});

describe("POST /trade", () => {
  const post = (app: ReturnType<typeof createApp>, raw: string, headers: Record<string, string> = {}) =>
    app.request("/trade", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });

  it("a vault without a session is refused with 401 and the plain sentence, before anything else", async () => {
    const res = await post(createApp(baseCtx), JSON.stringify({ ...trade, vault: baseCtx.deployment.demoVaultTestUSDG.address }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "SESSION_REQUIRED", message: SESSION_MESSAGES.SESSION_REQUIRED } });
  });

  it("a signed request from a linked session gets past the check (here, to 'no agent key': nothing is sent)", async () => {
    const app = createApp({ ...baseCtx, tradeAuth: auth({ now: () => Math.floor(Date.now() / 1000) }) });
    const req = await signed(linked, trade, { deadline: Math.floor(Date.now() / 1000) + 30 });
    const res = await post(app, req.raw, req.headers);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AGENT_KEY_MISSING");
    const again = await post(app, req.raw, req.headers);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("REPLAYED");
  });
});
