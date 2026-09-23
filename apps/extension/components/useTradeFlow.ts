/**
 * The buy flow, shared by the hover card, the floating panel and the side panel:
 *   idle -> quoting -> review (preflight passed) -> trading -> done
 *                   -> blocked (a vault guard said no, before or after sending)
 *                   -> failed (API offline, no vault, extension reloaded, ...)
 * The preflight is the API's on-chain simulation (GET /quote), never a guess.
 */
import { useCallback, useRef, useState } from "react";

import { api } from "../lib/api";
import { speak } from "../lib/voice";
import type { Guard, Quote, Trade } from "../lib/api-types";
import { isAddress } from "../lib/settings";
import { useGlance } from "./context";

export type FlowStep =
  | { step: "idle" }
  | { step: "quoting"; amount: string }
  | { step: "review"; amount: string; quote: Quote }
  | { step: "trading"; amount: string; quote: Quote }
  | { step: "done"; amount: string; quote: Quote; trade: Trade }
  | { step: "blocked"; amount: string; guard: Guard; quote?: Quote }
  | { step: "failed"; amount: string; code: string; message: string };

export function useTradeFlow(symbol: string, opts: { voice?: boolean } = {}) {
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
        if (opts.voice) void speak(quote.preflight.guard.message, g.voiceReplies);
        return;
      }
      setFlow({ step: "review", amount, quote });
      const line = `$${amount} of ${symbol} at $${Number(quote.price.value).toFixed(2)}. Confirm?`;
      const meta = `Price ${(quote.priceAgeSeconds / 3600).toFixed(1)}h old · market ${quote.marketState === "OPEN" ? "open" : "closed"}`;
      if (opts.voice) {
        g.setOrb({ state: "speaking", line, meta });
        await speak(line, g.voiceReplies);
        if (id !== run.current) return;
      }
      g.setOrb({ state: "idle", line, meta });
    },
    [g, symbol, opts.voice],
  );

  const confirm = useCallback(async () => {
    if (flow.step !== "review") return;
    const { amount, quote } = flow;
    const id = ++run.current;
    setFlow({ step: "trading", amount, quote });
    g.setOrb({ state: "thinking", line: `Buying $${amount} of ${symbol}`, meta: "Sending through your vault" });
    const res = await api.trade({ vault: g.vaultAddress, symbol, side: "buy", amount });
    if (id !== run.current) return;
    if (res.ok) {
      setFlow({ step: "done", amount, quote, trade: res.data });
      const got = res.data.filled?.tokensOut?.formatted ?? symbol;
      g.setOrb({ state: "success", line: `Bought ${got} for $${amount}`, meta: `tx ${res.data.txHash.slice(0, 6)}…${res.data.txHash.slice(-4)}` });
      void g.refreshVault();
    } else if (res.guard) {
      setFlow({ step: "blocked", amount, guard: res.guard, quote });
      g.setOrb({ state: "blocked", line: res.guard.message, meta: `Guard · ${res.guard.code}` });
    } else {
      setFlow({ step: "failed", amount, code: res.code, message: res.message });
      g.setOrb({ state: "idle", line: res.message, meta: "" });
    }
  }, [flow, g, symbol]);

  const reset = useCallback(() => {
    run.current++;
    setFlow({ step: "idle" });
    g.setOrb({ state: "idle" });
  }, [g]);

  return { flow, start, confirm, reset };
}
