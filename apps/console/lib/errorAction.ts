/**
 * Every error in onboarding gets exactly one way on, in plain words: Get gas, Get USDG, Switch network, Link Glance,
 * Set up my vault, or Try again. Chosen from the error's code when there is one, else from its own sentence.
 */
export type ErrorActionKind = "get-gas" | "get-usdg" | "switch-network" | "link-glance" | "set-up-vault" | "try-again";

export const ERROR_ACTION_LABELS: Record<ErrorActionKind, string> = {
  "get-gas": "Get gas",
  "get-usdg": "Get USDG",
  "switch-network": "Switch network",
  "link-glance": "Link Glance",
  "set-up-vault": "Set up my vault",
  "try-again": "Try again",
};

export function errorAction(message: string, code?: string): { kind: ErrorActionKind; label: string } {
  const kind = ((): ErrorActionKind => {
    if (code === "SESSION_REQUIRED" || code === "SESSION_EXPIRED") return "link-glance";
    if (code === "NO_VAULT" || code === "NOT_A_VAULT") return "set-up-vault";
    if (code === "wrong-network") return "switch-network";
    if (/test ETH for gas|insufficient funds|out of gas/i.test(message)) return "get-gas";
    if (/not enough (paxos )?usdg|faucet\.paxos\.com/i.test(message)) return "get-usdg";
    if (/another network|wrong network|switch to robinhood chain/i.test(message)) return "switch-network";
    return "try-again";
  })();
  return { kind, label: ERROR_ACTION_LABELS[kind] };
}
