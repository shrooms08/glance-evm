/**
 * This browser's session key: made once (viem generatePrivateKey), kept in chrome.storage.local, and used only in the
 * background worker to sign trade requests. The private key never leaves the extension and is never logged; only its
 * address is shown, sent to the console for linking, and sent with each request.
 *
 * The vault owner links the key in the console (an EIP-712 signature, never a transaction); see
 * packages/core/src/session.ts. "Unlink this browser" forgets the key here: the next link makes a new one.
 */
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { storage } from "wxt/utils/storage";

import { bodyHash, MAX_SESSION_SECONDS, randomNonce, SESSION_HEADERS, tradeTypedData } from "@glance/core/session";

const sessionPrivateKey = storage.defineItem<string | null>("local:sessionPrivateKey", { fallback: null });

/** What this browser last heard about its link (for the settings line; the API is the authority). */
export interface SessionLink {
  vault: string;
  expiresAt: number;
}
export const sessionLink = storage.defineItem<SessionLink | null>("local:sessionLink", { fallback: null });

let cached: PrivateKeyAccount | null = null;

/** The session account, made on first use. */
export async function sessionAccount(): Promise<PrivateKeyAccount> {
  if (cached) return cached;
  let key = (await sessionPrivateKey.getValue()) as `0x${string}` | null;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    key = generatePrivateKey();
    await sessionPrivateKey.setValue(key);
  }
  cached = privateKeyToAccount(key);
  return cached;
}

/** The session address only (safe to show and send). */
export async function sessionAddress(): Promise<`0x${string}`> {
  return (await sessionAccount()).address;
}

/** "Unlink this browser": forget the key (and the link). The vault owner can also unlink it from the console. */
export async function forgetSession(): Promise<void> {
  cached = null;
  await sessionPrivateKey.removeValue();
  await sessionLink.removeValue();
}

/** A new link's expiry: 30 days from now, the longest allowed. */
export function linkExpiry(now = Date.now()): number {
  return Math.floor(now / 1000) + MAX_SESSION_SECONDS - 60;
}

/** For tests only. */
export function resetSessionCacheForTests() {
  cached = null;
}

/** A trade request's deadline: 45 seconds ahead (the API allows at most 60). */
export const TRADE_REQUEST_SECONDS = 45;

export interface TradeBody {
  vault: string;
  symbol: string;
  side: "buy" | "sell";
  amount: string;
  slippageBps?: number;
}

/**
 * Signs a trade request with this browser's session key (EIP-712 GlanceTradeRequest): the exact body to send, and the
 * headers that carry the signature. A new random 128-bit nonce every time, so a request can be sent once only.
 */
export async function signTrade(body: TradeBody, now = Date.now()): Promise<{ raw: string; headers: Record<string, string> }> {
  const account = await sessionAccount();
  const raw = JSON.stringify(body);
  const deadline = Math.floor(now / 1000) + TRADE_REQUEST_SECONDS;
  const requestNonce = randomNonce(128);
  const signature = await account.signTypedData(
    tradeTypedData({
      vault: body.vault as `0x${string}`,
      action: "trade",
      token: body.symbol,
      amount: body.amount,
      side: body.side,
      maxSlippageBps: body.slippageBps ?? 0,
      deadline: BigInt(deadline),
      requestNonce,
      bodyHash: bodyHash(raw),
    }),
  );
  return {
    raw,
    headers: {
      [SESSION_HEADERS.session]: account.address,
      [SESSION_HEADERS.signature]: signature,
      [SESSION_HEADERS.deadline]: String(deadline),
      [SESSION_HEADERS.nonce]: `0x${requestNonce.toString(16)}`,
    },
  };
}
