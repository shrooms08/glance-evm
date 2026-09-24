/**
 * Get started's step statuses, from one pure function over the chain reads and the transaction in flight. The steps,
 * the header and the button all read from this, so the page can never say two things at once.
 */
import type { DemoVault } from "./deployment";
import { vaultConfigured, type SetupSnapshot } from "./setup";

export type StepKey = "connect" | "network" | "funds" | "vault" | "extension";
/**
 * "in-progress" is partial chain state with nothing in flight: e.g. the vault exists but holds no deposit yet, or the
 * wallet has test ETH but no USDG. It is never Done.
 */
export type StepStatus = "not-started" | "in-progress" | "waiting-wallet" | "confirming" | "done" | "failed";

export const STEP_ORDER: StepKey[] = ["connect", "network", "funds", "vault", "extension"];

export const STEP_TITLES: Record<StepKey, string> = {
  connect: "Connect your wallet",
  network: "Add Robinhood Chain testnet",
  funds: "Get test ETH and USDG",
  vault: "Create your vault and fund it",
  extension: "Install the Glance extension",
};

export const STATUS_LABELS: Record<StepStatus, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  "waiting-wallet": "Waiting for wallet",
  confirming: "Confirming",
  done: "Done",
  failed: "Failed",
};

/** The transaction (or wallet request) in flight, and which step it belongs to. */
export interface Activity {
  step: StepKey | null;
  /** checking and wallet both wait on the wallet; pending is confirming on chain. */
  phase: "idle" | "wallet" | "confirming" | "failed";
}

export interface StatusInputs {
  connected: boolean;
  onChain: boolean;
  /** Chain reads for the connected wallet; undefined while loading or with no wallet. */
  chain?: {
    eth: bigint;
    walletUsdg: bigint;
    snapshot: SetupSnapshot;
    flavour: DemoVault;
    usdgDecimals: number;
  };
  /** A deposit confirmed in this session (its receipt), in case the RPC's balance read lags behind it. */
  depositConfirmed: boolean;
  extension: boolean;
  activity: Activity;
}

export interface VaultProgress {
  exists: boolean;
  configured: boolean;
  funded: boolean;
}

export function vaultProgress(i: StatusInputs): VaultProgress {
  const c = i.chain;
  if (!c) return { exists: false, configured: false, funded: false };
  const exists = c.snapshot.vault !== null;
  return {
    exists,
    configured: exists && vaultConfigured(c.snapshot, c.flavour, c.usdgDecimals),
    funded: exists && (c.snapshot.vaultUsdgBalance > 0n || i.depositConfirmed),
  };
}

export function stepStatuses(i: StatusInputs): Record<StepKey, StepStatus> {
  const v = vaultProgress(i);
  const c = i.chain;
  const done: Record<StepKey, boolean> = {
    connect: i.connected,
    network: i.connected && i.onChain,
    funds: Boolean(c && c.eth > 0n && (c.walletUsdg > 0n || v.funded)),
    // Done means the vault exists, is configured AND holds a deposit. A created but unfunded vault is not done.
    vault: v.exists && v.configured && v.funded,
    extension: i.extension,
  };
  const partial: Record<StepKey, boolean> = {
    connect: false,
    network: false,
    funds: Boolean(c && (c.eth > 0n || c.walletUsdg > 0n)),
    vault: v.exists,
    extension: false,
  };
  const out = {} as Record<StepKey, StepStatus>;
  for (const key of STEP_ORDER) {
    const mine = i.activity.step === key;
    if (mine && i.activity.phase === "wallet") out[key] = "waiting-wallet";
    else if (mine && i.activity.phase === "confirming") out[key] = "confirming";
    else if (done[key]) out[key] = "done";
    else if (mine && i.activity.phase === "failed") out[key] = "failed";
    else out[key] = partial[key] ? "in-progress" : "not-started";
  }
  return out;
}

export type Summary = { complete: true; text: string } | { complete: false; text: string; step: StepKey; status: StepStatus; done: number };

/** "Setup complete" only when every step is Done; otherwise the first step that isn't. Never both. */
export function summarize(statuses: Record<StepKey, StepStatus>): Summary {
  const first = STEP_ORDER.find((k) => statuses[k] !== "done");
  if (!first) return { complete: true, text: "Setup complete" };
  const done = STEP_ORDER.filter((k) => statuses[k] === "done").length;
  const status = statuses[first];
  const text = status === "not-started" ? `Next: ${STEP_TITLES[first]}` : `${STEP_TITLES[first]}: ${STATUS_LABELS[status]}`;
  return { complete: false, text, step: first, status, done };
}

/**
 * What step 4 is doing right now, from real state only. "Confirming" needs a transaction hash (the wallet sent it and
 * the chain has yet to include it). Before that, including the pre-send simulation and the chain reads between steps,
 * it's "Waiting for wallet". A failed transaction, or a run that stopped with a reason, is "Failed" until the next run:
 * never silently back to "Not started". An "Add more" deposit is its own action and never moves step 4's status.
 */
export function activityFor(p: {
  switching: boolean;
  running: "setup" | "add-more" | null;
  lastMode: "setup" | "add-more" | null;
  tx: { status: string };
  runError: string | null;
}): Activity {
  if (p.switching) return { step: "network", phase: "wallet" };
  if (p.running === "setup") return { step: "vault", phase: p.tx.status === "pending" ? "confirming" : "wallet" };
  if (p.running === null && p.lastMode === "setup" && (p.tx.status === "failed" || p.runError)) return { step: "vault", phase: "failed" };
  return { step: null, phase: "idle" };
}
