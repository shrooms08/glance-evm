/**
 * Contract error translation. The extension, the console and the demo video all say these exact sentences, so every
 * string here is pinned by test/unit/errors.test.ts. Change a message there and here together.
 *
 * decodeRevert() turns raw revert data into { name, args } using every custom error the vault, the desk and the tokens
 * can raise (the vault bubbles desk and token errors up unchanged). explainRevert() turns that into a GuardError: a
 * machine `code` the UI can branch on, a short `message` the assistant can say, and structured `detail` (limits, how
 * far over, when it frees up, a suggested retry amount), with money formatted in the token's real decimals.
 */
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Abi, type Address, type Hex } from "viem";

import {
  erc20ErrorsAbi,
  glanceVaultAbi,
  glanceVaultFactoryAbi,
  stockDeskAbi,
  testUsdgAbi,
} from "./abi.generated.ts";
import { formatDuration, formatPercent, formatQuantity, formatUsd } from "./format.ts";
import { secondsUntilFits, type WindowEntry } from "./window.ts";

export type MarketState = "OPEN" | "CLOSED" | "STALE";
export type Side = "buy" | "sell";

export type GuardCode =
  | "PER_TRADE_CAP"
  | "DAILY_BUY_CAP"
  | "DAILY_SELL_CAP"
  | "ORACLE_STALE"
  | "ORACLE_BAD_PRICE"
  | "AGENT_EXPIRED"
  | "NOT_AGENT"
  | "PAUSED"
  | "TOKEN_NOT_APPROVED"
  | "NO_PRICE_FEED"
  | "ROUTER_NOT_APPROVED"
  | "SLIPPAGE"
  | "SHORT_FILL"
  | "INSUFFICIENT_BALANCE"
  | "BUFFER_FULL"
  | "NOT_OWNER"
  | "ZERO_AMOUNT"
  | "SEQUENCER_DOWN"
  | "SEQUENCER_GRACE"
  | "DESK_INVENTORY"
  | "DESK_PRICE_STALE"
  | "DESK_PRICE_MOVED"
  | "DESK_NOT_LISTED"
  | "TRANSFER_FAILED"
  | "REENTRANCY"
  | "INVALID_SETTING"
  | "FAUCET_LIMIT"
  | "PRICE_DRIFT"
  | "NOTHING_HELD"
  | "UNKNOWN";

export interface DecodedRevert {
  name: string;
  args: readonly unknown[];
  raw: Hex;
}

/** Everything explainRevert may use to make a message specific. Only `usdgDecimals` and `now` are required. */
export interface ExplainContext {
  usdgDecimals: number;
  /** Unix seconds. */
  now: number;
  side?: Side;
  /** Market state the vault applied to this trade (drives "while the market's closed"). */
  marketState?: MarketState;
  /** The stock being traded. */
  symbol?: string;
  tokenDecimals?: number;
  /** Token address -> symbol and decimals, to name tokens that appear in error arguments. */
  tokens?: Record<string, { symbol: string; decimals: number }>;
  usdgAddress?: Address;
  /** Live window entries, to say when a daily limit frees up. */
  buyWindow?: readonly WindowEntry[];
  sellWindow?: readonly WindowEntry[];
}

export interface GuardDetail {
  requested?: string;
  limit?: string;
  over?: string;
  remaining?: string;
  /** Seconds until the trade could go through, when that is knowable. */
  retryAfterSeconds?: number;
  /** A raw USDG amount that would pass this guard, when there is one. */
  suggestedAmount?: string;
  suggestedAmountFormatted?: string;
  [key: string]: string | number | undefined;
}

export interface GuardError {
  code: GuardCode;
  /** The contract error name, e.g. "ExceedsPerTradeCap". */
  error: string;
  message: string;
  /** Decoded error arguments, bigints as decimal strings. */
  args: Record<string, string>;
  detail: GuardDetail;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Every custom error the API can meet, de-duplicated by signature. */
export const allErrorsAbi: Abi = (() => {
  const seen = new Map<string, Abi[number]>();
  for (const abi of [glanceVaultAbi, stockDeskAbi, glanceVaultFactoryAbi, testUsdgAbi, erc20ErrorsAbi] as const) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const key = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (!seen.has(key)) seen.set(key, item);
    }
  }
  return [...seen.values()];
})();

const argNames = new Map<string, string[]>(
  allErrorsAbi
    .filter((i): i is Extract<Abi[number], { type: "error" }> => i.type === "error")
    .map((i) => [i.name, i.inputs.map((input, idx) => input.name || `arg${idx}`)]),
);

/** Decodes raw revert data. Returns null for empty data or an unknown selector. */
export function decodeRevert(raw: Hex | undefined | null): DecodedRevert | null {
  if (!raw || raw === "0x" || raw.length < 10) return null;
  try {
    const { errorName, args } = decodeErrorResult({ abi: allErrorsAbi, data: raw });
    return { name: errorName, args: args ?? [], raw };
  } catch {
    return null;
  }
}

/** Pulls raw revert data out of any viem error (simulate, estimate or send). */
export function revertDataFromError(err: unknown): Hex | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.raw) return reverted.raw;
  // Some RPC errors carry the data on the innermost cause instead.
  const withData = err.walk((e) => typeof (e as { data?: unknown }).data === "string");
  const data = (withData as { data?: unknown } | null)?.data;
  return typeof data === "string" && data.startsWith("0x") ? (data as Hex) : null;
}

// ---------------------------------------------------------------------------
// Explaining
// ---------------------------------------------------------------------------

const lower = (a: unknown) => String(a).toLowerCase();

function namedArgs(decoded: DecodedRevert): Record<string, string> {
  const names = argNames.get(decoded.name) ?? [];
  const out: Record<string, string> = {};
  decoded.args.forEach((value, i) => {
    out[names[i] ?? `arg${i}`] = typeof value === "bigint" ? value.toString() : String(value);
  });
  return out;
}

function tokenLabel(ctx: ExplainContext, token: unknown): { symbol: string; decimals: number } {
  const known = ctx.tokens?.[lower(token)];
  if (known) return known;
  if (ctx.usdgAddress && lower(token) === lower(ctx.usdgAddress)) return { symbol: "USDG", decimals: ctx.usdgDecimals };
  return { symbol: ctx.symbol ?? "that stock", decimals: ctx.tokenDecimals ?? 18 };
}

const closedSuffix = (ctx: ExplainContext) => (ctx.marketState === "CLOSED" ? " while the market's closed" : "");

/** Turns a decoded revert into a code, a sentence and structured detail. Pure: no I/O. */
export function explainRevert(decoded: DecodedRevert | null, ctx: ExplainContext): GuardError {
  if (!decoded) {
    return {
      code: "UNKNOWN",
      error: "Unknown",
      message: "The chain rejected that for a reason I don't recognise, so nothing moved.",
      args: {},
      detail: {},
    };
  }
  const args = namedArgs(decoded);
  const a = decoded.args;
  const usd = (raw: unknown) => formatUsd(BigInt(raw as bigint), ctx.usdgDecimals);
  const make = (code: GuardCode, message: string, detail: GuardDetail = {}): GuardError => ({
    code,
    error: decoded.name,
    message,
    args,
    detail,
  });

  switch (decoded.name) {
    case "ExceedsPerTradeCap": {
      const [requested, cap] = a as [bigint, bigint];
      const detail: GuardDetail = {
        requested: requested.toString(),
        limit: cap.toString(),
        over: (requested - cap).toString(),
        suggestedAmount: cap.toString(),
        suggestedAmountFormatted: usd(cap),
      };
      if (cap === 0n) {
        return make(
          "PER_TRADE_CAP",
          `This vault doesn't allow trading${closedSuffix(ctx) || " right now"}.`,
          { ...detail, suggestedAmount: undefined, suggestedAmountFormatted: undefined },
        );
      }
      const offer = ctx.side === "sell" ? `sell ${usd(cap)} worth` : `buy ${usd(cap)}`;
      // A sell says the rule first, in the market's words: "The market is closed, so each trade is capped at $25."
      if (ctx.side === "sell") {
        const rule = ctx.marketState === "CLOSED" ? `The market is closed, so each trade is capped at ${usd(cap)}.` : `Each trade is capped at ${usd(cap)}.`;
        return make("PER_TRADE_CAP", `${rule} Want me to ${offer} instead?`, detail);
      }
      return make(
        "PER_TRADE_CAP",
        `That's over your ${usd(cap)} per trade limit${closedSuffix(ctx)}. Want me to ${offer} instead?`,
        detail,
      );
    }

    case "ExceedsDailyCap":
    case "ExceedsDailySellCap": {
      const [used, requested, cap] = a as [bigint, bigint, bigint];
      const sell = decoded.name === "ExceedsDailySellCap";
      const code: GuardCode = sell ? "DAILY_SELL_CAP" : "DAILY_BUY_CAP";
      const limitName = sell ? "daily sell limit" : "daily limit";
      const remaining = cap > used ? cap - used : 0n;
      const window = sell ? ctx.sellWindow : ctx.buyWindow;
      const wait = window ? secondsUntilFits(window, ctx.now, cap, requested) : null;
      const when = wait === null || wait === 0 ? "within 24 hours" : `in ${formatDuration(wait, "up")}`;
      const detail: GuardDetail = {
        requested: requested.toString(),
        limit: cap.toString(),
        used: used.toString(),
        remaining: remaining.toString(),
        over: (used + requested - cap).toString(),
        retryAfterSeconds: wait ?? undefined,
      };
      // Anything under a cent left is effectively nothing left.
      const spent = remaining < 10n ** BigInt(Math.max(0, ctx.usdgDecimals - 2));
      if (sell) {
        // The rule first, then what's left: "The market is closed, so sells are capped at $125 a day."
        const rule = `${ctx.marketState === "CLOSED" ? "The market is closed, so sells are" : "Sells are"} capped at ${usd(cap)} a day`;
        if (spent) return make(code, `${rule}, and you've sold that much. It frees up ${when}.`, detail);
        return make(
          code,
          `${rule}. You have ${usd(remaining)} left. Want me to sell ${usd(remaining)} worth instead? The rest frees up ${when}.`,
          { ...detail, suggestedAmount: remaining.toString(), suggestedAmountFormatted: usd(remaining) },
        );
      }
      if (spent) {
        return make(code, `You've used your ${limitName}${closedSuffix(ctx)}. It frees up ${when}.`, detail);
      }
      const verb = sell ? `sell ${usd(remaining)} worth` : `buy ${usd(remaining)}`;
      return make(
        code,
        `You have ${usd(remaining)} left of your ${usd(cap)} ${limitName}${closedSuffix(ctx)}. Want me to ${verb} instead? The rest frees up ${when}.`,
        { ...detail, suggestedAmount: remaining.toString(), suggestedAmountFormatted: usd(remaining) },
      );
    }

    case "OracleStale": {
      const [updatedAt] = a as [bigint];
      const age = ctx.now - Number(updatedAt);
      return make(
        "ORACLE_STALE",
        `The market's closed and the price is ${formatDuration(age)} old, so I'm not trading on it.`,
        { updatedAt: Number(updatedAt), ageSeconds: age },
      );
    }

    case "InvalidOraclePrice":
    case "OracleTimestampInFuture":
      return make("ORACLE_BAD_PRICE", "The price feed returned a bad value, so I'm not trading on it.");

    case "AgentExpired": {
      const [expiry] = a as [bigint];
      const ago = ctx.now - Number(expiry);
      return make(
        "AGENT_EXPIRED",
        `My permission to trade for you expired ${formatDuration(ago)} ago. Renew it in the console and I can carry on.`,
        { expiry: Number(expiry) },
      );
    }

    case "NotAgent":
      return make(
        "NOT_AGENT",
        "I'm not the approved agent on this vault, so I can't trade for it. Add me in the console first.",
      );

    case "VaultPaused":
      return make("PAUSED", "Trading is paused on this vault. Unpause it in the console to let me trade.");

    case "TokenNotApproved": {
      const { symbol } = tokenLabel(ctx, a[0]);
      return make("TOKEN_NOT_APPROVED", `${symbol} isn't on this vault's approved list, so I can't trade it.`);
    }

    case "MissingPriceFeed": {
      const { symbol } = tokenLabel(ctx, a[0]);
      return make("NO_PRICE_FEED", `${symbol} has no price feed on this vault, so I can't price it.`);
    }

    case "RouterNotApproved":
      return make(
        "ROUTER_NOT_APPROVED",
        "This vault hasn't approved the trading desk, so I can't place the order.",
      );

    case "SlippageTooHigh": {
      const [minOut, floor] = a as [bigint, bigint];
      const pct = formatPercent(floor - minOut, floor);
      return make("SLIPPAGE", `That price is ${pct} outside your slippage limit, so I didn't trade.`, {
        minOut: minOut.toString(),
        floor: floor.toString(),
        shortfallPercent: pct,
      });
    }

    case "InsufficientOutput":
      return make("SHORT_FILL", "The desk filled less than it quoted, so the trade was cancelled and nothing moved.");

    case "InsufficientBalance": {
      const [balance, needed] = a as [bigint, bigint];
      const detail: GuardDetail = { balance: balance.toString(), needed: needed.toString() };
      if (ctx.side === "sell") {
        const held = formatQuantity(balance, ctx.tokenDecimals ?? 18, ctx.symbol);
        return make("INSUFFICIENT_BALANCE", `You only hold ${held} in the vault.`, detail);
      }
      return make("INSUFFICIENT_BALANCE", `You only have ${usd(balance)} in the vault. Add funds or buy less.`, {
        ...detail,
        suggestedAmount: balance.toString(),
        suggestedAmountFormatted: usd(balance),
      });
    }

    case "SpendBufferFull": {
      const [freesAt] = a as [bigint];
      const wait = Number(freesAt) - ctx.now;
      return make(
        "BUFFER_FULL",
        `You've made 32 trades in the last 24 hours, the most this vault allows. The next one frees up in ${formatDuration(wait, "up")}.`,
        { retryAfterSeconds: Math.max(0, wait) },
      );
    }

    case "NotOwner":
    case "OwnableUnauthorizedAccount":
      return make("NOT_OWNER", "Only the vault owner can do that. I can trade, but I can never move your money out.");

    case "ZeroAmount":
    case "ZeroOutput":
      return make("ZERO_AMOUNT", "That amount is too small to trade.");

    case "SequencerDown":
      return make(
        "SEQUENCER_DOWN",
        "The network's sequencer is down, so prices can't be trusted right now. I'll wait until it's back.",
      );

    case "SequencerGracePeriod": {
      const [trustedFrom] = a as [bigint];
      const wait = Number(trustedFrom) - ctx.now;
      return make(
        "SEQUENCER_GRACE",
        `The network just came back from an outage. I'll trust prices again in ${formatDuration(wait, "up")}.`,
        { retryAfterSeconds: Math.max(0, wait) },
      );
    }

    case "InsufficientInventory": {
      const [token, available] = a as [Address, bigint, bigint];
      const label = tokenLabel(ctx, token);
      if (label.symbol === "USDG") {
        return make(
          "DESK_INVENTORY",
          `The trading desk only has ${usd(available)} left to pay out right now. Try a smaller sale.`,
        );
      }
      return make(
        "DESK_INVENTORY",
        `The trading desk only has ${formatQuantity(available, label.decimals, label.symbol)} left. Try a smaller buy.`,
      );
    }

    case "StalePrice": {
      const [token, updatedAt] = a as [Address, bigint];
      const { symbol } = tokenLabel(ctx, token);
      return make(
        "DESK_PRICE_STALE",
        `The desk's price for ${symbol} is ${formatDuration(ctx.now - Number(updatedAt))} old, so it won't quote.`,
      );
    }

    case "BelowMinOut":
      return make("DESK_PRICE_MOVED", "The desk's price moved since the quote. Ask me again for a fresh one.");

    case "NotListed": {
      const { symbol } = tokenLabel(ctx, a[0]);
      return make("DESK_NOT_LISTED", `The trading desk doesn't list ${symbol}.`);
    }

    case "SafeERC20FailedOperation":
    case "ERC20InsufficientBalance":
    case "ERC20InsufficientAllowance":
    case "ERC20InvalidSender":
    case "ERC20InvalidReceiver":
    case "ERC20InvalidApprover":
    case "ERC20InvalidSpender":
      return make("TRANSFER_FAILED", "A token transfer failed, so the trade was cancelled and nothing moved.");

    case "ReentrancyGuardReentrantCall":
      return make("REENTRANCY", "The vault blocked a re-entrant call, so nothing moved.");

    case "FaucetCapExceeded":
      return make("FAUCET_LIMIT", "You've taken today's 1,000 test USDG from the faucet. Try again tomorrow.");

    case "InvalidLimits":
      return make(
        "INVALID_SETTING",
        "Those limits don't fit together: the per-trade limit must be above zero and no bigger than either daily limit.",
      );
    case "InvalidAgentExpiry":
      return make("INVALID_SETTING", "An agent's permission has to end in the future and last at most 30 days.");
    case "InvalidFreshness":
      return make(
        "INVALID_SETTING",
        "Those price freshness settings don't work: the open limit must be above zero, and the closed limit longer but at most 7 days.",
      );
    case "InvalidTokenConfig":
    case "ZeroAddress":
    case "InvalidArgument":
    case "SpreadTooHigh":
    case "SafeCastOverflowedUintDowncast":
    case "VaultAlreadyExists":
    case "OwnableInvalidOwner":
      return make("INVALID_SETTING", "That setting isn't valid, so nothing changed.");

    default:
      return make("UNKNOWN", "The chain rejected that for a reason I don't recognise, so nothing moved.");
  }
}

// ---------------------------------------------------------------------------
// The API's own guard: live market price vs the vault's oracle
// ---------------------------------------------------------------------------

/**
 * The live market price and the price the vault would trade at (its oracle, mirrored from mainnet Chainlink) disagree
 * by more than the API allows (LIVE_ORACLE_MAX_GAP_BPS): the oracle is behind the market, so the trade would be priced
 * off an old number. This is the API's refusal, not the vault's; nothing was sent.
 */
export function priceDriftGuard(o: { name: string; livePrice: number; oraclePrice: number; gapBps: number; maxGapBps: number; liveSource: string }): GuardError {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  return {
    code: "PRICE_DRIFT",
    error: "PriceDrift",
    message: `The on-chain price is behind the market right now, so I won't trade ${o.name} yet.`,
    args: {},
    detail: {
      livePrice: usd(o.livePrice),
      oraclePrice: usd(o.oraclePrice),
      gapBps: Math.round(o.gapBps),
      gap: `${(o.gapBps / 100).toFixed(1)}%`,
      maxGapBps: o.maxGapBps,
      liveSource: o.liveSource,
    },
  };
}
