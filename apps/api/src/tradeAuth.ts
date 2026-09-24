/**
 * Who may ask the agent to trade a vault. POST /trade is the only route that makes the agent sign a transaction; before
 * it does, the request must be signed (EIP-712 GlanceTradeRequest) by a browser session the vault's owner linked:
 *
 *   SESSION_REQUIRED  no session, or one this vault never linked (or unlinked)
 *   SESSION_EXPIRED   the link has expired
 *   BAD_SIGNATURE     the signature isn't the session's, the body was changed after signing, or the deadline is more
 *                     than 60 seconds ahead
 *   REPLAYED          the request nonce was already used, or the deadline has passed
 *
 * The signature is checked before the nonce is recorded, so nobody can burn a nonce without the session key. Seen
 * nonces are kept until their deadline (at most 60s): after that the deadline alone refuses the request.
 *
 * The open demo vaults (OPEN_DEMO_VAULTS) may trade without a session, so anyone can try Glance, limited per IP (default
 * 10 trades an hour) and logged. A browser that IS linked to a demo vault is checked like any other.
 *
 * The vault's on-chain caps still apply to every trade: this is an extra layer, not a replacement.
 */
import { createHash } from "node:crypto";

import { isAddressEqual, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { bodyHash, MAX_REQUEST_SECONDS, SESSION_HEADERS, SESSION_MESSAGES, tradeTypedData, type SessionErrorCode } from "@glance/core/session";

import { ApiError } from "./services.js";
import type { Sessions } from "./sessions.js";

/** Clock difference we tolerate between the browser and the server. */
const SKEW_SECONDS = 5;

export interface TradeFields {
  vault: Address;
  symbol: string;
  side: "buy" | "sell";
  amount: string;
  slippageBps?: number;
}

export interface TradeAuthDeps {
  sessions: Pick<Sessions, "status">;
  chainId: number;
  openDemoVaults: readonly Address[];
  demoTradesPerHour: number;
  now?: () => number;
  log?: (line: string) => void;
}

export type TradeAuthResult = { via: "session"; session: Address } | { via: "demo"; used: number; limit: number };

const refuse = (code: SessionErrorCode): never => {
  throw new ApiError(401, code, SESSION_MESSAGES[code]);
};

export function createTradeAuth(d: TradeAuthDeps) {
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const log = d.log ?? ((l: string) => console.log(l));
  const seen = new Map<string, number>();
  const demo = new Map<string, { count: number; resetAt: number }>();

  const isDemo = (vault: Address) => d.openDemoVaults.some((v) => isAddressEqual(v, vault));

  function openDemoTrade(vault: Address, ip: string): TradeAuthResult {
    const t = now();
    let entry = demo.get(ip);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + 3_600 };
      demo.set(ip, entry);
    }
    if (entry.count >= d.demoTradesPerHour) {
      log(`[demo] open trade refused on demo vault ${short(vault)} from ${ipTag(ip)}: ${d.demoTradesPerHour} this hour already`);
      throw new ApiError(429, "DEMO_LIMIT", `The demo vault allows ${d.demoTradesPerHour} trades an hour from each visitor. Try again later, or link your own vault.`);
    }
    entry.count++;
    log(`[demo] open trade on demo vault ${short(vault)} from ${ipTag(ip)} (${entry.count}/${d.demoTradesPerHour} this hour)`);
    return { via: "demo", used: entry.count, limit: d.demoTradesPerHour };
  }

  return {
    isDemo,

    /**
     * Checks one trade request. `raw` is the exact body as received (its hash is signed); `fields` is that body, parsed.
     * Throws a 401 ApiError with one of the four codes, or 429 when an open demo vault's limit is reached.
     */
    async check(input: { raw: string; fields: TradeFields; header(name: string): string | undefined; ip: string }): Promise<TradeAuthResult> {
      const { fields, header } = input;
      const t = now();
      const sessionKey = header(SESSION_HEADERS.session);
      const demoVault = isDemo(fields.vault);

      if (!sessionKey || !/^0x[0-9a-fA-F]{40}$/.test(sessionKey)) return demoVault ? openDemoTrade(fields.vault, input.ip) : refuse("SESSION_REQUIRED");
      const status = d.sessions.status(fields.vault, sessionKey as Address);
      if (!status.linked) {
        // Not linked to this vault: the demo vaults stay open; every other vault needs the owner's link.
        if (demoVault) return openDemoTrade(fields.vault, input.ip);
        return refuse(status.reason === "expired" ? "SESSION_EXPIRED" : "SESSION_REQUIRED");
      }

      const signature = header(SESSION_HEADERS.signature);
      const deadlineText = header(SESSION_HEADERS.deadline);
      const nonceText = header(SESSION_HEADERS.nonce);
      if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature) || !deadlineText || !/^\d{1,12}$/.test(deadlineText) || !nonceText || !/^0x[0-9a-fA-F]{1,32}$/.test(nonceText)) {
        return refuse("BAD_SIGNATURE");
      }
      const deadline = Number(deadlineText);
      if (deadline > t + MAX_REQUEST_SECONDS + SKEW_SECONDS) return refuse("BAD_SIGNATURE");
      if (deadline < t) return refuse("REPLAYED");

      const requestNonce = BigInt(nonceText);
      const typed = tradeTypedData(
        {
          vault: fields.vault,
          action: "trade",
          token: fields.symbol,
          amount: fields.amount,
          side: fields.side,
          maxSlippageBps: fields.slippageBps ?? 0,
          deadline: BigInt(deadline),
          requestNonce,
          bodyHash: bodyHash(input.raw),
        },
        d.chainId,
      );
      const signer = await recoverTypedDataAddress({ ...typed, signature: signature as Hex }).catch(() => null);
      if (!signer || !isAddressEqual(signer, sessionKey as Address)) return refuse("BAD_SIGNATURE");

      // Only now, with the session's own signature checked: the nonce is single use.
      for (const [k, until] of seen) if (until < t) seen.delete(k);
      const nonceKey = `${fields.vault.toLowerCase()}:${requestNonce.toString(16)}`;
      if (seen.has(nonceKey)) return refuse("REPLAYED");
      seen.set(nonceKey, deadline);
      return { via: "session", session: sessionKey as Address };
    },
  };
}

export type TradeAuth = ReturnType<typeof createTradeAuth>;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** The IP as a short tag in the log (enough to tell visitors apart, not to identify one). */
const ipTag = (ip: string) => `visitor ${createHash("sha256").update(ip).digest("hex").slice(0, 8)}`;
