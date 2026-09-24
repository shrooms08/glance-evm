/**
 * Get started's runner: carries out a setup plan one wallet confirmation at a time. Before every transaction it
 * re-reads the chain and re-plans, so nothing already in place is sent again, and a step confirmed in this run is
 * never repeated even if a lagging RPC hasn't caught up. Every way it can end is explicit (and the page shows it):
 *
 *   done       nothing left to do
 *   blocked    the plan can't continue (e.g. not enough USDG), in the plan's own words
 *   stopped    the runner stopped on its own, with a reason (never silently)
 *   tx-failed  a transaction didn't go through; its status already says why
 *
 * Only a step that targets the vault needs the vault to exist. In the one-transaction flow the first step is the USDG
 * approve (to the factory), which a fresh wallet with no vault must be able to send.
 */
import type { Address, Hex } from "viem";

import type { SetupPlan, SetupSnapshot, SetupStep } from "./setup";

export type RunOutcome =
  | { kind: "done"; sent: number }
  | { kind: "blocked"; reason: string; sent: number }
  | { kind: "stopped"; reason: string; sent: number }
  | { kind: "tx-failed"; sent: number };

/** One fresh read of the chain, and the plan for it (mode-specific; `deposited` once a deposit confirmed in this run). */
export interface RunnerRead {
  snapshot: SetupSnapshot;
  plan(deposited: boolean): SetupPlan;
}

export interface RunnerDeps {
  read(): Promise<RunnerRead>;
  /** Sends one step's transaction to `target`; the hash once confirmed, null if it didn't go through. */
  send(step: SetupStep, target: Address, args: readonly unknown[]): Promise<Hex | null>;
  /** Called when a step that moves USDG in (deposit, or the one-transaction create with a deposit) confirms. */
  onDeposited(hash: Hex): void;
  /** "add-more" stops after its one deposit; "setup" runs to the end. */
  mode: "setup" | "add-more";
  /** Whether the create step carries a deposit (so its confirmation counts as funding). */
  createDeposits: boolean;
  sleep?(ms: number): Promise<void>;
  maxSteps?: number;
}

export const STOPPED_VAULT_NOT_VISIBLE =
  "Your vault was created, but the testnet isn't showing it yet, so setup paused here. Refresh in a moment and click Finish setup.";
export const STOPPED_NO_VAULT = "This step needs your vault, and the chain doesn't show one for this wallet yet. Refresh and try again.";
export const STOPPED_TOO_MANY = "Setup stopped after too many steps. Refresh and check what's left.";

export async function runSetupSteps(d: RunnerDeps): Promise<RunOutcome> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const confirmed = new Set<string>();
  let deposited = false;
  let sent = 0;
  for (let i = 0; i < (d.maxSteps ?? 25); i++) {
    let r = await d.read();
    const created = confirmed.has("create") || confirmed.has("create-configured");
    if (created) {
      // Just created: give the RPC a moment to show the new vault before planning anything else.
      for (let wait = 0; !r.snapshot.vault && wait < 5; wait++) {
        await sleep(1_000);
        r = await d.read();
      }
      // Still not visible: stop rather than plan a second vault (the factory would refuse one anyway).
      if (!r.snapshot.vault) return { kind: "stopped", reason: STOPPED_VAULT_NOT_VISIBLE, sent };
    }
    const s = r.snapshot;
    const plan = r.plan(deposited);
    if (plan.blocked) return { kind: "blocked", reason: plan.blocked, sent };
    const step = plan.steps.find((st) => !confirmed.has(st.id));
    if (!step) return { kind: "done", sent };

    // A step with no fixed address targets the vault, and only those need one. (Approving USDG to the factory, the
    // factory's own create, the faucet: none of them does.)
    const target = step.call.address ?? s.vault;
    if (!target) return { kind: "stopped", reason: STOPPED_NO_VAULT, sent };
    const args = step.id === "allow" ? [s.vault, step.call.args[1]] : step.call.args;

    const hash = await d.send(step, target, args);
    sent++;
    if (!hash) return { kind: "tx-failed", sent };
    confirmed.add(step.id);
    if (step.id === "deposit" || (step.id === "create-configured" && d.createDeposits)) {
      deposited = true;
      d.onDeposited(hash);
      if (d.mode === "add-more") return { kind: "done", sent }; // one deposit per click, never more
    }
  }
  return { kind: "stopped", reason: STOPPED_TOO_MANY, sent };
}
