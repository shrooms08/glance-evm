/**
 * Buying a basket:
 *   idle -> quoting -> review (every leg preflighted: pass, or why not) -> sending (each leg as it lands) -> finished
 *                                                                       -> failed (nothing was sent)
 * The plan splits the total by weight, rounded down to the cent, the remainder to the largest leg. The API checks every
 * leg against the vault (token allowed, per-trade cap, price freshness and the weekend guard, slippage) and the legs
 * together against the rolling buy cap. A failing leg is never sent: the review offers "Buy the other N" or "Cancel".
 * One tap sends one signed request (GlanceBasketRequest, every leg in one signature); the API sends the legs one by one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { planBasket, type Basket, type PlannedLeg } from "@glance/core/basket";

import { api } from "../lib/api";
import type { BasketLegResult, BasketPreflight } from "../lib/api-types";
import { recordBasketBuy, type PageContext } from "../lib/journal";
import { legsToSend } from "../lib/baskets";
import { isAddress } from "../lib/settings";
import { useGlance } from "./context";

export type BasketFlow =
  | { step: "idle" }
  | { step: "quoting"; basket: Basket; total: string; plan: PlannedLeg[] }
  | { step: "review"; basket: Basket; total: string; plan: PlannedLeg[]; report: BasketPreflight }
  | { step: "sending"; basket: Basket; total: string; report: BasketPreflight; legs: BasketLegResult[] }
  | { step: "finished"; basket: Basket; total: string; report: BasketPreflight; legs: BasketLegResult[]; state: "done" | "stopped" | "failed"; message: string | null }
  | { step: "failed"; basket: Basket; total: string; code: string; message: string };

/** How often the panel asks how the legs are going, and for how long at most. */
export const BASKET_POLL_MS = 1_000;
const BASKET_POLL_LIMIT_MS = 5 * 60_000;

export function useBasketFlow(opts: { pageContext?: () => Promise<PageContext | null> | PageContext | null; sleep?: (ms: number) => Promise<void> } = {}) {
  const g = useGlance();
  const [flow, setFlow] = useState<BasketFlow>({ step: "idle" });
  const run = useRef(0);
  useEffect(() => () => void run.current++, []);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const start = useCallback(
    async (basket: Basket, total: string) => {
      const id = ++run.current;
      let plan: PlannedLeg[];
      try {
        plan = planBasket(total, basket.legs);
      } catch (err) {
        setFlow({ step: "failed", basket, total, code: "BAD_AMOUNT", message: (err as Error).message });
        return;
      }
      if (!isAddress(g.vaultAddress)) {
        setFlow({ step: "failed", basket, total, code: "NO_VAULT", message: "Add your vault address in settings to trade." });
        return;
      }
      setFlow({ step: "quoting", basket, total, plan });
      g.setOrb({ state: "thinking", line: `Checking each stock in ${basket.name} against your vault's limits`, meta: "Preflight on chain" });
      const res = await api.quoteBasket({ vault: g.vaultAddress, legs: plan.map((l) => ({ symbol: l.symbol, amount: l.amount })) });
      if (id !== run.current) return;
      if (!res.ok) {
        setFlow({ step: "failed", basket, total, code: res.code, message: res.message });
        g.setOrb({ state: "idle", line: res.message, meta: "" });
        return;
      }
      const report = res.data;
      setFlow({ step: "review", basket, total, plan, report });
      const failing = report.legs.length - report.passing;
      const line =
        failing === 0
          ? `$${total} of ${basket.name}: ${report.legs.length} buys. Confirm?`
          : report.passing === 0
            ? `None of ${basket.name} can be bought right now.`
            : `${failing} of ${report.legs.length} can't be bought right now. Buy the other ${report.passing}?`;
      g.setOrb({ state: failing ? "blocked" : "idle", line, meta: `${report.capLeftAfter} left today after this` });
    },
    [g],
  );

  /** Sends the legs that passed (all of them, or "the other N"): one signature, then each leg as it lands. */
  const confirm = useCallback(async () => {
    if (flow.step !== "review") return;
    const { basket, total, report } = flow;
    const legs = legsToSend(report);
    if (legs.length === 0) return;
    const id = ++run.current;
    const page = Promise.resolve()
      .then(() => opts.pageContext?.() ?? null)
      .catch(() => null);
    const waiting: BasketLegResult[] = legs.map((l) => ({ symbol: l.symbol, amount: l.amount, status: "waiting" }));
    setFlow({ step: "sending", basket, total, report, legs: waiting });
    g.setOrb({ state: "thinking", line: `Buying ${basket.name}, one stock at a time`, meta: "Sending through your vault" });
    const res = await api.tradeBasket({ vault: g.vaultAddress, legs });
    if (id !== run.current) return;
    if (!res.ok) {
      // Nothing was sent (not linked, a leg that no longer passes, the API offline...).
      setFlow({ step: "failed", basket, total, code: res.code, message: res.message });
      g.setOrb({ state: "idle", line: res.message, meta: "" });
      return;
    }
    const began = Date.now();
    let latest = res.data.legs;
    for (;;) {
      await sleep(BASKET_POLL_MS);
      if (id !== run.current) return;
      const job = await api.basketJob(res.data.jobId);
      if (id !== run.current) return;
      if (job.ok) {
        latest = job.data.legs;
        if (job.data.state !== "running") {
          const priceOf = new Map(report.legs.map((l) => [l.symbol, l.price]));
          void recordBasketBuy(page, basket, latest.map((l) => ({ ...l, priceAtBuy: priceOf.get(l.symbol) ?? null })));
          setFlow({ step: "finished", basket, total, report, legs: latest, state: job.data.state, message: job.data.message });
          const done = latest.filter((l) => l.status === "done").length;
          g.setOrb(
            done === latest.length
              ? { state: "success", line: `Bought ${basket.name}: ${done} stocks for $${total}`, meta: "Receipt below" }
              : { state: "blocked", line: `${done} of ${latest.length} went through. The basket stopped there.`, meta: "Receipt below" },
          );
          void g.refreshVault();
          return;
        }
        setFlow({ step: "sending", basket, total, report, legs: latest });
      }
      if (Date.now() - began > BASKET_POLL_LIMIT_MS) {
        setFlow({ step: "finished", basket, total, report, legs: latest, state: "failed", message: "This is taking longer than it should. Check your activity in the console." });
        return;
      }
    }
  }, [flow, g, opts, sleep]);

  const reset = useCallback(() => {
    run.current++;
    setFlow({ step: "idle" });
    g.setOrb({ state: "idle" });
  }, [g]);

  return { flow, start, confirm, reset };
}
