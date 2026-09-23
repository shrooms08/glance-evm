/**
 * The blocked card's brain: given the API's guard (machine code + human sentence + numbers), decide the card's title,
 * the facts to show, and the one constructive next step. Pure, so every branch is unit tested.
 * Framing: the vault protected the user. Nothing here says "error".
 */
import type { Guard } from "./api-types";
import { clockIn, fromRaw, until, usd } from "./format";

export type GuardAction =
  | { kind: "retry"; amount: string; label: string }
  | { kind: "wait"; seconds: number; label: string }
  | { kind: "requote"; label: string }
  | { kind: "console"; label: string }
  | { kind: "settings"; label: string };

export interface GuardView {
  title: string;
  message: string;
  /** Short mono line naming the guard, e.g. "Guard · per-trade cap $100". */
  meta: string;
  facts: Array<{ label: string; value: string }>;
  primary?: GuardAction;
  secondary?: GuardAction;
}

const money = (raw: string | undefined, d: number) => (raw === undefined ? "?" : usd(raw, d));

export function viewForGuard(guard: Guard, usdgDecimals = 6, now = Date.now()): GuardView {
  const d = guard.detail ?? {};
  const base = { message: guard.message };
  const waitFacts = (seconds: number | undefined) =>
    seconds === undefined || seconds <= 0 ? [] : [{ label: "Frees up", value: `in ${until(seconds)} · ${clockIn(seconds, now)}` }];

  switch (guard.code) {
    case "PER_TRADE_CAP": {
      const retry = d.suggestedAmount ? fromRaw(d.suggestedAmount, usdgDecimals) : undefined;
      return {
        ...base,
        title: "Held to your per-trade limit",
        meta: `Guard · per-trade cap ${money(d.limit, usdgDecimals)}`,
        facts: [
          { label: "You asked for", value: money(d.requested, usdgDecimals) },
          { label: "Limit per trade", value: money(d.limit, usdgDecimals) },
        ],
        primary: retry ? { kind: "retry", amount: retry, label: `Buy ${usd(d.suggestedAmount!, usdgDecimals)} instead` } : undefined,
      };
    }
    case "DAILY_BUY_CAP":
    case "DAILY_SELL_CAP": {
      const sell = guard.code === "DAILY_SELL_CAP";
      const retry = d.suggestedAmount ? fromRaw(d.suggestedAmount, usdgDecimals) : undefined;
      const seconds = typeof d.retryAfterSeconds === "number" ? d.retryAfterSeconds : undefined;
      return {
        ...base,
        title: sell ? "Your daily sell limit is used" : "Your daily limit is used",
        meta: `Guard · 24h ${sell ? "sell" : "buy"} cap ${money(d.limit, usdgDecimals)}`,
        facts: [
          { label: "Used in 24h", value: money(d.used as string | undefined, usdgDecimals) },
          { label: "Left", value: money(d.remaining, usdgDecimals) },
          ...waitFacts(seconds),
        ],
        primary: retry ? { kind: "retry", amount: retry, label: `${sell ? "Sell" : "Buy"} ${usd(d.suggestedAmount!, usdgDecimals)} instead` } : undefined,
        secondary: seconds ? { kind: "wait", seconds, label: `Frees up in ${until(seconds)}` } : undefined,
      };
    }
    case "ORACLE_STALE": {
      const age = typeof d.ageSeconds === "number" ? d.ageSeconds : undefined;
      return {
        ...base,
        title: "The price is too old to trade on",
        meta: "Guard · stale oracle",
        facts: age === undefined ? [] : [{ label: "Price age", value: `${Math.round(age / 3600)}h` }],
      };
    }
    case "AGENT_EXPIRED":
    case "NOT_AGENT":
      return {
        ...base,
        title: guard.code === "AGENT_EXPIRED" ? "My permission has expired" : "I'm not authorised on this vault",
        meta: "Guard · agent key",
        facts: [],
        primary: { kind: "console", label: guard.code === "AGENT_EXPIRED" ? "Renew in the console" : "Authorise in the console" },
      };
    case "PAUSED":
      return { ...base, title: "Trading is paused", meta: "Guard · vault paused", facts: [], primary: { kind: "console", label: "Open the console" } };
    case "INSUFFICIENT_BALANCE": {
      const retry = d.suggestedAmount && BigInt(d.suggestedAmount) > 0n ? fromRaw(d.suggestedAmount, usdgDecimals) : undefined;
      return {
        ...base,
        title: "Not enough in the vault",
        meta: "Guard · vault balance",
        facts: [],
        primary: retry ? { kind: "retry", amount: retry, label: `Buy ${usd(d.suggestedAmount!, usdgDecimals)} instead` } : { kind: "console", label: "Add funds in the console" },
      };
    }
    case "SLIPPAGE":
    case "DESK_PRICE_MOVED":
    case "SHORT_FILL":
      return { ...base, title: "The price moved", meta: "Guard · price floor", facts: [], primary: { kind: "requote", label: "Get a fresh quote" } };
    case "BUFFER_FULL":
    case "SEQUENCER_GRACE": {
      const seconds = typeof d.retryAfterSeconds === "number" ? d.retryAfterSeconds : undefined;
      return {
        ...base,
        title: guard.code === "BUFFER_FULL" ? "That's the most trades for today" : "Waiting out a network restart",
        meta: guard.code === "BUFFER_FULL" ? "Guard · 32 trades per 24h" : "Guard · sequencer grace period",
        facts: waitFacts(seconds),
        secondary: seconds ? { kind: "wait", seconds, label: `Frees up in ${until(seconds)}` } : undefined,
      };
    }
    case "SEQUENCER_DOWN":
      return { ...base, title: "The network is down", meta: "Guard · sequencer uptime", facts: [] };
    case "TOKEN_NOT_APPROVED":
    case "ROUTER_NOT_APPROVED":
    case "NO_PRICE_FEED":
      return { ...base, title: "Not set up on this vault", meta: "Guard · vault allowlist", facts: [], primary: { kind: "console", label: "Open the console" } };
    case "DESK_INVENTORY":
      return { ...base, title: "The desk is short", meta: "Guard · desk inventory", facts: [] };
    default:
      return { ...base, title: "Your vault held this back", meta: `Guard · ${guard.error}`, facts: [] };
  }
}
