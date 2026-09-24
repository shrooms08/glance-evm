/**
 * Browser sessions linked by the vault owner (EIP-712): the owner's link and revoke signatures are accepted, any other
 * signer is refused, a link past 30 days is refused, a link can't be replayed (not even after an unlink), and a revoked
 * session reads as unlinked. Fakes only: generated throwaway keys, and a fake vault.owner().
 */
import { resolve } from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { MAX_SESSION_SECONDS, ONLY_OWNER, revokeTypedData, sessionTypedData } from "@glance/core/session";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { createSessions, JsonSessionStore } from "../../src/sessions.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const baseCtx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {});

const NOW = 1_790_000_000;
const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const browser = privateKeyToAccount(generatePrivateKey());

function sessionsApp(o: { owner?: Address; now?: () => number } = {}) {
  const sessions = createSessions({
    store: new JsonSessionStore(null),
    ownerOf: async (vault) => {
      if (vault.toLowerCase() !== VAULT.toLowerCase()) throw new Error("not a vault");
      return o.owner ?? owner.address;
    },
    chainId: 46_630,
    now: o.now ?? (() => NOW),
    log: () => {},
  });
  return { app: createApp({ ...baseCtx, sessions }), sessions };
}

/** A response body, as the tests read it. */
interface Body {
  error: { code: string; message: string };
  sessions: unknown[];
}
const read = async (r: Response): Promise<Body> => (await r.json()) as Body;

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

async function linkRequest(signer = owner, m: Partial<{ expiresAt: bigint; issuedAt: bigint; nonce: bigint; sessionKey: Address }> = {}) {
  const message = { vault: VAULT, sessionKey: m.sessionKey ?? browser.address, expiresAt: m.expiresAt ?? BigInt(NOW + 7 * 86_400), issuedAt: m.issuedAt ?? BigInt(NOW), nonce: m.nonce ?? 1n };
  const typed = sessionTypedData(message);
  const signature = await signer.signTypedData(typed);
  return { typedData: { domain: typed.domain, primaryType: typed.primaryType, message }, signature };
}

async function revokeRequest(signer = owner, nonce = 9n) {
  const message = { vault: VAULT, sessionKey: browser.address, nonce };
  const typed = revokeTypedData(message);
  return { typedData: { domain: typed.domain, primaryType: typed.primaryType, message }, signature: await signer.signTypedData(typed) };
}

const post = (app: ReturnType<typeof sessionsApp>["app"], path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: json(body) });

describe("linking a browser (EIP-712, signed by the vault owner)", () => {
  it("the owner's signature links the session; status then says linked until the expiry", async () => {
    const { app } = sessionsApp();
    const res = await post(app, "/session/link", await linkRequest());
    expect(res.status).toBe(200);
    expect(await read(res)).toMatchObject({ linked: true, sessionKey: browser.address, expiresAt: NOW + 7 * 86_400 });
    const status = await (await app.request(`/session/status?vault=${VAULT}&session=${browser.address}`)).json();
    expect(status).toEqual({ linked: true, expiresAt: NOW + 7 * 86_400, linkedAt: NOW });
    const list = await read(await app.request(`/session/list?vault=${VAULT}`));
    expect(list.sessions).toEqual([{ sessionKey: browser.address, linkedAt: NOW, expiresAt: NOW + 7 * 86_400, expired: false }]);
  });

  it("any other wallet is refused: only the owner can link a browser", async () => {
    const { app } = sessionsApp();
    const res = await post(app, "/session/link", await linkRequest(stranger));
    expect(res.status).toBe(403);
    expect(await read(res)).toEqual({ error: { code: "NOT_OWNER", message: ONLY_OWNER } });
    expect(await (await app.request(`/session/status?vault=${VAULT}&session=${browser.address}`)).json()).toEqual({ linked: false, reason: "unknown" });
  });

  it("a link longer than 30 days is refused, and so is one already expired", async () => {
    const { app } = sessionsApp();
    const long = await post(app, "/session/link", await linkRequest(owner, { expiresAt: BigInt(NOW + MAX_SESSION_SECONDS + 3_600) }));
    expect(long.status).toBe(400);
    expect((await read(long)).error.code).toBe("TOO_LONG");
    const past = await post(app, "/session/link", await linkRequest(owner, { expiresAt: BigInt(NOW - 1), nonce: 2n }));
    expect((await read(past)).error.code).toBe("SESSION_EXPIRED");
  });

  it("a signature for another chain or vault is refused; a tampered message doesn't recover to the owner", async () => {
    const { app } = sessionsApp();
    const req = await linkRequest();
    const otherChain = await post(app, "/session/link", { ...req, typedData: { ...req.typedData, domain: { ...req.typedData.domain, chainId: 1 } } });
    expect((await read(otherChain)).error.code).toBe("BAD_DOMAIN");
    const tampered = await post(app, "/session/link", { ...req, typedData: { ...req.typedData, message: { ...req.typedData.message, expiresAt: BigInt(NOW + 20 * 86_400) } } });
    expect(tampered.status).toBe(403);
  });

  it("a link can't be replayed, not even to relink a browser after it was unlinked", async () => {
    const { app } = sessionsApp();
    const req = await linkRequest();
    expect((await post(app, "/session/link", req)).status).toBe(200);
    expect((await post(app, "/session/revoke", await revokeRequest())).status).toBe(200);
    const again = await post(app, "/session/link", req);
    expect(again.status).toBe(409);
    expect((await read(again)).error.code).toBe("REPLAYED");
  });
});

describe("unlinking", () => {
  it("the owner's revoke signature unlinks it; the session is then refused and leaves the list", async () => {
    const { app, sessions } = sessionsApp();
    await post(app, "/session/link", await linkRequest());
    const res = await post(app, "/session/revoke", await revokeRequest());
    expect(res.status).toBe(200);
    expect(sessions.status(VAULT, browser.address)).toEqual({ linked: false, reason: "revoked" });
    expect(sessions.list(VAULT)).toEqual([]);
  });

  it("only the owner can unlink", async () => {
    const { app, sessions } = sessionsApp();
    await post(app, "/session/link", await linkRequest());
    const res = await post(app, "/session/revoke", await revokeRequest(stranger));
    expect(res.status).toBe(403);
    expect(sessions.status(VAULT, browser.address).linked).toBe(true);
  });

  it("an expired session reads as expired", async () => {
    let now = NOW;
    const { app, sessions } = sessionsApp({ now: () => now });
    await post(app, "/session/link", await linkRequest(owner, { expiresAt: BigInt(NOW + 60) }));
    now = NOW + 61;
    expect(sessions.status(VAULT, browser.address)).toEqual({ linked: false, reason: "expired", expiresAt: NOW + 60 });
  });

  it("an address that isn't a vault: 404", async () => {
    const { app } = sessionsApp();
    const req = await linkRequest();
    const other = "0x2222222222222222222222222222222222222222" as Address;
    const typed = sessionTypedData({ ...req.typedData.message, vault: other });
    const res = await post(app, "/session/link", { typedData: { domain: typed.domain, primaryType: typed.primaryType, message: typed.message }, signature: await owner.signTypedData(typed) });
    expect(res.status).toBe(404);
  });
});
