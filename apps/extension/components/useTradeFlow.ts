/**
 * The buy flow, shared by the hover card, the floating panel and the side panel:
 *   idle -> quoting -> review (preflight passed) -> trading -> done
 *                   -> blocked (a vault guard said no, before or after sending)
 *                   -> failed (API offline, no vault, extension reloaded, ...)
 * The preflight is the API's on-chain simulation (GET /quote), never a guess.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { onChainRecovered } from "../lib/chainStatus";
import { speak } from "../lib/voiceClient";
import type { Guard, Quote, Trade } from "../lib/api-types";
import { recordTrade, type PageContext } from "../lib/journal";
import { isAddress } from "../lib/settings";
import { LINK_CODES, startLinking, waitForLink } from "../lib/linking";
import { useGlance } from "./context";

export type FlowStep =
  | { step: "idle" }
  | { step: "quoting"; amount: string }
  | { step: "review"; amount: string; quote: Quote }
  | { step: "trading"; amount: string; quote: Quote }
  | { step: "done"; amount: string; quote: Quote; trade: Trade }
  | { step: "blocked"; amount: string; guard: Guard; quote?: Quote }
  | { step: "failed"; amount: string; code: string; message: string }
  /**
   * The API wants this browser linked to the vault first (SESSION_REQUIRED / SESSION_EXPIRED): the card offers to link
   * it (the owner signs in the console), then to send the same buy again in one tap.
   */
  | { step: "needs-link"; amount: string; quote: Quote; code: string; message: string; link: "idle" | "waiting" | "linked" | "failed"; until?: number };

/** Where a buy was placed from, for the headline journal (null: not from a page). */
export type PageContextSource = () => Promise<PageContext | null> | PageContext | null;

export function useTradeFlow(symbol: string, opts: { voice?: boolean; pageContext?: PageContextSource } = {}) {
  const g = useGlance();
  const [flow, setFlow] = useState<FlowStep>({ step: "idle" });
  const run = useRef(0);

  const start = useCallback(
    async (amount: string) => {
      const id = ++run.current;
      if (!isAddress(g.vaultAddress)) {
        setFlow({ step: "failed", amount, code: "NO_VAULT", message: "Add your vault address in settings to trade." });
        return;
      }
      setFlow({ step: "quoting", amount });
      g.setOrb({ state: "thinking", line: `Checking ${symbol} price and your vault limits`, meta: "Preflight on chain" });
      const res = await api.quote({ vault: g.vaultAddress, symbol, side: "buy", amount });
      if (id !== run.current) return;
      if (!res.ok) {
        setFlow({ step: "failed", amount, code: res.code, message: res.message });
        g.setOrb({ state: "idle", line: res.message, meta: "" });
        return;
      }
      const quote = res.data;
      if (!quote.preflight.ok) {
        setFlow({ step: "blocked", amount, guard: quote.preflight.guard, quote });
        g.setOrb({ state: "blocked", line: quote.preflight.guard.message, meta: `Guard · ${quote.preflight.guard.code}` });
        if (opts.voice) void speak(quote.preflight.guard.message, g.voiceReplies); // the blocked orb stays: the card explains
        return;
      }
      setFlow({ step: "review", amount, quote });
      const line = `$${amount} of ${symbol} at $${Number(quote.price.value).toFixed(2)}. Confirm?`;
      const meta = `Price ${(quote.priceAgeSeconds / 3600).toFixed(1)}h old · market ${quote.marketState === "OPEN" ? "open" : "closed"}`;
      g.setOrb({ state: "idle", line, meta });
      if (opts.voice) {
        // The orb moves exactly while the voice speaks, from the utterance's own start and end events.
        await speak(line, g.voiceReplies, {
          onStart: () => id === run.current && g.setOrb({ state: "speaking", line, meta }),
          onEnd: () => id === run.current && g.setOrb({ state: "idle", line, meta }),
        });
      }
    },
    [g, symbol, opts.voice],
  );

  const linking = useRef<AbortController | null>(null);
  useEffect(() => () => linking.current?.abort(), []);

  const send = useCallback(async (amount: string, quote: Quote) => {
    const id = ++run.current;
    // The page the buy was placed from, as it is at this moment (for the journal; kept only in this browser).
    const page = Promise.resolve()
      .then(() => opts.pageContext?.() ?? null)
      .catch(() => null);
    setFlow({ step: "trading", amount, quote });
    g.setOrb({ state: "thinking", line: `Buying $${amount} of ${symbol}`, meta: "Sending through your vault" });
    const res = await api.trade({ vault: g.vaultAddress, symbol, side: "buy", amount });
    if (id !== run.current) return;
    if (res.ok) {
      setFlow({ step: "done", amount, quote, trade: res.data });
      // The headline journal (this browser only): where this buy came from, now that it's confirmed.
      void recordTrade(page, res.data, { symbol, amount, priceAtBuy: quote.price.value });
      const got = res.data.filled?.tokensOut?.formatted ?? symbol;
      g.setOrb({ state: "success", line: `Bought ${got} for $${amount}`, meta: `tx ${res.data.txHash.slice(0, 6)}…${res.data.txHash.slice(-4)}` });
      void g.refreshVault();
    } else if (res.guard) {
      setFlow({ step: "blocked", amount, guard: res.guard, quote });
      g.setOrb({ state: "blocked", line: res.guard.message, meta: `Guard · ${res.guard.code}` });
    } else if (LINK_CODES.has(res.code)) {
      // Nothing was sent: this browser isn't linked to the vault yet (or its link ran out).
      setFlow({ step: "needs-link", amount, quote, code: res.code, message: res.message, link: "idle" });
      g.setOrb({ state: "idle", line: res.message, meta: "" });
    } else {
      setFlow({ step: "failed", amount, code: res.code, message: res.message });
      g.setOrb({ state: "idle", line: res.message, meta: "" });
    }
  }, [g, symbol, opts]);

  const confirm = useCallback(async () => {
    if (flow.step !== "review") return;
    await send(flow.amount, flow.quote);
  }, [flow, send]);

  /** Opens the console to link this browser, then waits for the owner's signature. */
  const link = useCallback(async () => {
    if (flow.step !== "needs-link" || flow.link === "waiting") return;
    const base = flow;
    linking.current?.abort();
    const abort = (linking.current = new AbortController());
    setFlow({ ...base, link: "waiting" });
    const started = await startLinking(g.vaultAddress);
    if (!started) return setFlow({ ...base, link: "failed" });
    const status = await waitForLink(g.vaultAddress, started.address, { signal: abort.signal });
    if (abort.signal.aborted) return;
    setFlow(status.linked ? { ...base, link: "linked", until: status.expiresAt } : { ...base, link: "failed" });
  }, [flow, g.vaultAddress]);

  /** After linking: the same buy, in one tap (the API runs the on-chain preflight again before sending). */
  const retry = useCallback(async () => {
    if (flow.step !== "needs-link") return;
    await send(flow.amount, flow.quote);
  }, [flow, send]);

  // A quote that failed only because the testnet wasn't answering tries again, on its own, once it answers.
  useEffect(() => {
    if (flow.step !== "failed" || flow.code !== "RPC_UNAVAILABLE") return;
    const amount = flow.amount;
    return onChainRecovered(() => void start(amount));
  }, [flow, start]);

  const reset = useCallback(() => {
    run.current++;
    linking.current?.abort();
    setFlow({ step: "idle" });
    g.setOrb({ state: "idle" });
  }, [g]);

  return { flow, start, confirm, reset, link, retry };
}
