/**
 * Every error on a trade card gets exactly one way on, in plain words: Set up my vault, Link Glance, or Try again.
 * (Guard refusals have their own card, components/BlockedCard.tsx, with its own single action.)
 */
export type TradeErrorAction = { kind: "set-up-vault" | "link-glance" | "try-again"; label: string };

export function tradeErrorAction(code: string): TradeErrorAction {
  if (code === "NO_VAULT" || code === "DEMO_LIMIT" || code === "NOT_A_VAULT") return { kind: "set-up-vault", label: "Set up my vault" };
  if (code === "SESSION_REQUIRED" || code === "SESSION_EXPIRED") return { kind: "link-glance", label: "Link Glance" };
  return { kind: "try-again", label: "Try again" };
}
