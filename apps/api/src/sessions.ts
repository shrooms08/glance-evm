/**
 * Browser sessions, linked by the vault's owner (see packages/core/src/session.ts for the design).
 *
 *   POST /session/link     { typedData, signature }: the owner's GlanceSession signature -> the session is stored
 *   POST /session/revoke   { typedData, signature }: the owner's GlanceSessionRevoke signature -> the session is revoked
 *   GET  /session/status   ?vault&session: linked, until when (the extension polls it while the owner signs)
 *   GET  /session/list     ?vault: the vault's browser sessions (the console's "Linked browsers" card)
 *
 * The signer must be vault.owner(), read on chain (V1 and V2 vaults alike). Link and revoke nonces are single use,
 * and kept for good: a link signature can't be replayed to relink a browser after it was unlinked. Sessions live in a
 * small store (JSON in the gitignored .cache here) behind an interface a hosted deployment can swap.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getAddress, isAddressEqual, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import {
  MAX_SESSION_SECONDS,
  ONLY_OWNER,
  revokeTypedData,
  sessionTypedData,
  type GlanceSession,
  type GlanceSessionRevoke,
} from "@glance/core/session";

import { ApiError } from "./services.js";

export interface StoredSession {
  vault: Address;
  sessionKey: Address;
  /** Unix seconds. */
  expiresAt: number;
  issuedAt: number;
  linkedAt: number;
  revoked: boolean;
  revokedAt?: number;
}

/** Where sessions and used link/revoke nonces live. JSON on disk here; a hosted deployment can swap in a database. */
export interface SessionStore {
  get(vault: Address, sessionKey: Address): StoredSession | null;
  put(session: StoredSession): void;
  list(vault: Address): StoredSession[];
  /** Marks a nonce used; false if it already was. */
  useNonce(scope: string, nonce: string): boolean;
}

const key = (vault: Address, sessionKey: Address) => `${vault.toLowerCase()}:${sessionKey.toLowerCase()}`;

/** Sessions as one JSON file (written atomically), or in memory when `file` is null. */
export class JsonSessionStore implements SessionStore {
  private sessions = new Map<string, StoredSession>();
  private nonces = new Set<string>();

  constructor(private readonly file: string | null) {
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as { sessions?: StoredSession[]; nonces?: string[] };
        for (const s of data.sessions ?? []) this.sessions.set(key(s.vault, s.sessionKey), s);
        for (const n of data.nonces ?? []) this.nonces.add(n);
      } catch {
        // An unreadable file starts empty: every browser links again. Nothing here is a secret.
      }
    }
  }

  get(vault: Address, sessionKey: Address) {
    return this.sessions.get(key(vault, sessionKey)) ?? null;
  }

  put(session: StoredSession) {
    this.sessions.set(key(session.vault, session.sessionKey), session);
    this.save();
  }

  list(vault: Address) {
    return [...this.sessions.values()].filter((s) => isAddressEqual(s.vault, vault));
  }

  useNonce(scope: string, nonce: string) {
    const k = `${scope}:${nonce}`;
    if (this.nonces.has(k)) return false;
    this.nonces.add(k);
    this.save();
    return true;
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: [...this.sessions.values()], nonces: [...this.nonces] }, null, 1));
    renameSync(tmp, this.file);
  }
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address").transform((v) => getAddress(v));
const uint = z.union([z.string().regex(/^\d{1,78}$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/, "must be a 65-byte signature") as unknown as z.ZodType<Hex>;
const domain = z.object({ name: z.string(), version: z.string(), chainId: z.union([z.number(), z.string()]), verifyingContract: address });

export const linkBody = z.object({
  typedData: z.object({
    domain,
    primaryType: z.literal("GlanceSession"),
    message: z.object({ vault: address, sessionKey: address, expiresAt: uint, issuedAt: uint, nonce: uint }),
  }),
  signature,
});

export const revokeBody = z.object({
  typedData: z.object({
    domain,
    primaryType: z.literal("GlanceSessionRevoke"),
    message: z.object({ vault: address, sessionKey: address, nonce: uint }),
  }),
  signature,
});

/** How far a signed link's issuedAt may be ahead of our clock, and how old it may be. */
const ISSUED_SKEW_SECONDS = 300;
const ISSUED_MAX_AGE_SECONDS = 24 * 60 * 60;

export interface SessionsDeps {
  store: SessionStore;
  /** vault.owner(), read on chain. */
  ownerOf(vault: Address): Promise<Address>;
  chainId: number;
  now?: () => number;
  log?: (line: string) => void;
}

export type SessionStatus = { linked: false; reason: "unknown" | "revoked" | "expired"; expiresAt?: number } | { linked: true; expiresAt: number; linkedAt: number };

export function createSessions(d: SessionsDeps) {
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const log = d.log ?? ((l: string) => console.log(l));

  /** The domain the signature must be for: Glance v1, this chain, the vault itself. */
  function checkDomain(dom: z.infer<typeof domain>, vault: Address) {
    if (dom.name !== "Glance" || dom.version !== "1" || Number(dom.chainId) !== d.chainId || !isAddressEqual(dom.verifyingContract, vault)) {
      throw new ApiError(400, "BAD_DOMAIN", "That signature is for a different app, chain or vault.");
    }
  }

  async function checkOwner(vault: Address, signer: Address) {
    let owner: Address;
    try {
      owner = await d.ownerOf(vault);
    } catch {
      throw new ApiError(404, "NOT_A_VAULT", "That address isn't a Glance vault.");
    }
    if (!isAddressEqual(owner, signer)) throw new ApiError(403, "NOT_OWNER", ONLY_OWNER);
  }

  return {
    store: d.store,

    async link(input: z.infer<typeof linkBody>): Promise<StoredSession> {
      const m = input.typedData.message;
      checkDomain(input.typedData.domain, m.vault);
      const t = now();
      if (m.expiresAt <= BigInt(t)) throw new ApiError(400, "SESSION_EXPIRED", "That link has already expired. Start linking again.");
      if (m.expiresAt > BigInt(t + MAX_SESSION_SECONDS + ISSUED_SKEW_SECONDS)) throw new ApiError(400, "TOO_LONG", "A browser can be linked for 30 days at most.");
      if (m.issuedAt > BigInt(t + ISSUED_SKEW_SECONDS) || m.issuedAt < BigInt(t - ISSUED_MAX_AGE_SECONDS)) {
        throw new ApiError(400, "STALE_LINK", "That link request is too old. Start linking again.");
      }
      const message: GlanceSession = m;
      const signer = await recoverTypedDataAddress({ ...sessionTypedData(message, d.chainId), signature: input.signature }).catch(() => {
        throw new ApiError(400, "BAD_SIGNATURE", "That signature couldn't be read.");
      });
      await checkOwner(m.vault, signer);
      if (!d.store.useNonce(`link:${m.vault.toLowerCase()}`, m.nonce.toString())) throw new ApiError(409, "REPLAYED", "That link was already used. Start linking again.");
      const session: StoredSession = { vault: m.vault, sessionKey: m.sessionKey, expiresAt: Number(m.expiresAt), issuedAt: Number(m.issuedAt), linkedAt: t, revoked: false };
      d.store.put(session);
      log(`[session] linked ${short(m.sessionKey)} to vault ${short(m.vault)} until ${new Date(session.expiresAt * 1000).toISOString().slice(0, 10)}`);
      return session;
    },

    async revoke(input: z.infer<typeof revokeBody>): Promise<{ revoked: true }> {
      const m = input.typedData.message;
      checkDomain(input.typedData.domain, m.vault);
      const message: GlanceSessionRevoke = m;
      const signer = await recoverTypedDataAddress({ ...revokeTypedData(message, d.chainId), signature: input.signature }).catch(() => {
        throw new ApiError(400, "BAD_SIGNATURE", "That signature couldn't be read.");
      });
      await checkOwner(m.vault, signer);
      if (!d.store.useNonce(`revoke:${m.vault.toLowerCase()}`, m.nonce.toString())) throw new ApiError(409, "REPLAYED", "That unlink was already used.");
      const t = now();
      const existing = d.store.get(m.vault, m.sessionKey);
      d.store.put({ ...(existing ?? { vault: m.vault, sessionKey: m.sessionKey, expiresAt: t, issuedAt: t, linkedAt: t }), revoked: true, revokedAt: t });
      log(`[session] unlinked ${short(m.sessionKey)} from vault ${short(m.vault)}`);
      return { revoked: true };
    },

    status(vault: Address, sessionKey: Address): SessionStatus {
      const s = d.store.get(vault, sessionKey);
      if (!s) return { linked: false, reason: "unknown" };
      if (s.revoked) return { linked: false, reason: "revoked" };
      if (s.expiresAt <= now()) return { linked: false, reason: "expired", expiresAt: s.expiresAt };
      return { linked: true, expiresAt: s.expiresAt, linkedAt: s.linkedAt };
    },

    /** The vault's browsers that are still linked or have expired (not the revoked ones), newest first. */
    list(vault: Address) {
      const t = now();
      return d.store
        .list(vault)
        .filter((s) => !s.revoked)
        .sort((a, b) => b.linkedAt - a.linkedAt)
        .map((s) => ({ sessionKey: s.sessionKey, linkedAt: s.linkedAt, expiresAt: s.expiresAt, expired: s.expiresAt <= t }));
    },
  };
}

export type Sessions = ReturnType<typeof createSessions>;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
