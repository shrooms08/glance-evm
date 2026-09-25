/**
 * Browser sessions and signed trade requests: the EIP-712 types the extension, the console and the API must agree on.
 *
 * The threat: the agent key lives on the API, so anyone who could call POST /trade with a vault address could make the
 * agent trade that vault (within its on-chain caps). Now:
 *  1. The extension makes a session keypair once per browser. The vault OWNER links it, by signing a GlanceSession in
 *     the console (a signature, never a transaction). The API checks the signer is vault.owner() on chain.
 *  2. Every trade request is signed by that session key (GlanceTradeRequest), with a deadline at most 60s ahead, a
 *     random 128-bit nonce, and the hash of the exact request body. The API checks all of it before the agent signs.
 *  3. The owner can revoke a session (GlanceSessionRevoke), again by signature.
 * The vault's on-chain caps still apply to every trade: this is an extra layer, not a replacement. A session can never
 * withdraw: the only thing it can do is ask the agent to trade, and the agent can never withdraw either.
 */
import { keccak256, stringToBytes, type Address, type Hex } from "viem";

/** Robinhood Chain testnet. */
export const SESSION_CHAIN_ID = 46_630;
/** A link lasts at most 30 days. */
export const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;
/** A trade request's deadline is at most 60 seconds ahead. */
export const MAX_REQUEST_SECONDS = 60;

export function sessionDomain(vault: Address, chainId: number = SESSION_CHAIN_ID) {
  return { name: "Glance", version: "1", chainId, verifyingContract: vault } as const;
}

export const SESSION_TYPES = {
  GlanceSession: [
    { name: "vault", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "expiresAt", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const REVOKE_TYPES = {
  GlanceSessionRevoke: [
    { name: "vault", type: "address" },
    { name: "sessionKey", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const TRADE_TYPES = {
  GlanceTradeRequest: [
    { name: "vault", type: "address" },
    { name: "action", type: "string" },
    /** The ticker ("TSLA"): what the owner reads and the API resolves against its catalog. */
    { name: "token", type: "string" },
    /** The amount exactly as sent, a decimal string ("25", "0.5"). */
    { name: "amount", type: "string" },
    { name: "side", type: "string" },
    /** 0: the vault's own default. */
    { name: "maxSlippageBps", type: "uint16" },
    { name: "deadline", type: "uint64" },
    { name: "requestNonce", type: "uint128" },
    /** keccak256 of the exact request body bytes. */
    { name: "bodyHash", type: "bytes32" },
  ],
} as const;

/** A basket buy: every leg in one signature (the same rules as GlanceTradeRequest: linked session, deadline, replay, body). */
export const BASKET_TYPES = {
  BasketLeg: [
    { name: "token", type: "string" },
    { name: "amount", type: "string" },
    { name: "side", type: "string" },
  ],
  GlanceBasketRequest: [
    { name: "vault", type: "address" },
    { name: "legs", type: "BasketLeg[]" },
    { name: "maxSlippageBps", type: "uint16" },
    { name: "deadline", type: "uint64" },
    { name: "requestNonce", type: "uint128" },
    { name: "bodyHash", type: "bytes32" },
  ],
} as const;

export interface GlanceBasketRequest {
  vault: Address;
  legs: Array<{ token: string; amount: string; side: string }>;
  maxSlippageBps: number;
  deadline: bigint;
  requestNonce: bigint;
  bodyHash: Hex;
}

export function basketTypedData(m: GlanceBasketRequest, chainId: number = SESSION_CHAIN_ID) {
  return { domain: sessionDomain(m.vault, chainId), types: BASKET_TYPES, primaryType: "GlanceBasketRequest", message: m } as const;
}

export interface GlanceSession {
  vault: Address;
  sessionKey: Address;
  expiresAt: bigint;
  issuedAt: bigint;
  nonce: bigint;
}

export interface GlanceSessionRevoke {
  vault: Address;
  sessionKey: Address;
  nonce: bigint;
}

export interface GlanceTradeRequest {
  vault: Address;
  action: string;
  token: string;
  amount: string;
  side: string;
  maxSlippageBps: number;
  deadline: bigint;
  requestNonce: bigint;
  bodyHash: Hex;
}

export function sessionTypedData(m: GlanceSession, chainId: number = SESSION_CHAIN_ID) {
  return { domain: sessionDomain(m.vault, chainId), types: SESSION_TYPES, primaryType: "GlanceSession", message: m } as const;
}

export function revokeTypedData(m: GlanceSessionRevoke, chainId: number = SESSION_CHAIN_ID) {
  return { domain: sessionDomain(m.vault, chainId), types: REVOKE_TYPES, primaryType: "GlanceSessionRevoke", message: m } as const;
}

export function tradeTypedData(m: GlanceTradeRequest, chainId: number = SESSION_CHAIN_ID) {
  return { domain: sessionDomain(m.vault, chainId), types: TRADE_TYPES, primaryType: "GlanceTradeRequest", message: m } as const;
}

/** The hash a trade request signs over: keccak256 of the body's UTF-8 bytes, exactly as sent. */
export function bodyHash(raw: string): Hex {
  return keccak256(stringToBytes(raw));
}

/** The request headers of a signed trade. */
export const SESSION_HEADERS = {
  session: "x-glance-session",
  signature: "x-glance-signature",
  deadline: "x-glance-deadline",
  nonce: "x-glance-nonce",
} as const;

export type SessionErrorCode = "SESSION_REQUIRED" | "SESSION_EXPIRED" | "BAD_SIGNATURE" | "REPLAYED";

/** What the extension shows for each refusal, in plain words. */
export const SESSION_MESSAGES: Record<SessionErrorCode, string> = {
  SESSION_REQUIRED: "Link this browser to your vault first.",
  SESSION_EXPIRED: "This browser's link to your vault has expired. Link it again.",
  BAD_SIGNATURE: "That request's signature didn't check out, so nothing was sent.",
  REPLAYED: "That request was already sent or is too old, so it wasn't sent again. Try once more.",
};

export const ONLY_OWNER = "Only the vault owner can link a browser.";
export const VOICE_RESTING = "Voice is resting for today. You can still type.";

/** "12 October 2026": a link's expiry, as the owner reads it. */
export function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** The sentence the owner reads before signing. */
export function authorization(expiresAt: number): string {
  return `This browser may ask Glance to trade your vault within its limits until ${formatExpiry(expiresAt)}. It can never withdraw.`;
}

/** The console page that links a browser. */
export function linkUrl(consoleBase: string, vault: Address, session: Address, expiresAt: number): string {
  const q = new URLSearchParams({ vault, session, expires: String(expiresAt) });
  return `${consoleBase.replace(/\/+$/, "")}/link?${q.toString()}`;
}

/** A random 128-bit nonce (trade requests) or 256-bit (links, revocations). */
export function randomNonce(bits: 128 | 256): bigint {
  const bytes = new Uint8Array(bits / 8);
  crypto.getRandomValues(bytes);
  return BigInt(`0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
}
