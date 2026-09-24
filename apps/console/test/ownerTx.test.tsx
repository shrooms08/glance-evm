/**
 * Owner transactions can't fail silently: every failure ends in "failed" with the reason on the page and one
 * console.error("[glance-console]", ...). "Pending" (Confirming) only exists once there's a hash.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, UnauthorizedProviderError, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { glanceVaultAbi } from "@glance/core/abi";

import { TxStatus } from "../components/TxStatus";
import { activityFor, stepStatuses } from "../lib/setupStatus";
import { TX_MESSAGES } from "../lib/txMessages";
import { executeOwnerTx, type OwnerTxDeps, type TxState } from "../lib/useOwnerTx";

const ACCOUNT = "0xE5AE75Dd9D7130FA4cf80926bab410e1d440730F" as const;
const HASH = `0x${"ab".repeat(32)}` as Hex;
const REQ = { label: "Approve 50 Paxos USDG", address: "0x7E955252E15c84f5768B83c41a71F9eba181802F" as const, abi: glanceVaultAbi, functionName: "approve", args: [] };

function deps(over: Partial<OwnerTxDeps> = {}) {
  const states: TxState[] = [];
  const d: OwnerTxDeps = {
    account: ACCOUNT,
    usdgDecimals: 6,
    simulate: vi.fn(async () => ({})),
    write: vi.fn(async () => HASH),
    waitForReceipt: vi.fn(async () => ({ status: "success" as const, blockNumber: 10n })),
    onState: (s) => states.push(s),
    ...over,
  };
  return { d, states };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("executeOwnerTx", () => {
  it("a rejected simulation shows Failed with the reason, logs once, and never opens the wallet", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const data = encodeErrorResult({ abi: glanceVaultAbi, errorName: "InvalidLimits" });
    const { d, states } = deps({
      simulate: vi.fn(async () => {
        throw new BaseError("reverted", { cause: new ContractFunctionRevertedError({ abi: glanceVaultAbi, data, functionName: "setLimits" }) });
      }),
    });
    expect(await executeOwnerTx(d, REQ)).toBeNull();
    expect(states.map((s) => s.status)).toEqual(["checking", "failed"]);
    expect(states[1]).toMatchObject({
      status: "failed",
      message: "Those limits don't fit together: the per-trade limit must be above zero and no bigger than either daily limit.",
    });
    expect(d.write).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toBe("[glance-console]");
    expect(log.mock.calls[0]![1]).toBe("Approve 50 Paxos USDG: simulation");

    // And the page shows it.
    render(<TxStatus state={states[1]!} />);
    expect(screen.getByRole("alert").textContent).toContain("Those limits don't fit together");
  });

  it("Confirming (pending) only once a hash exists: checking, wallet, pending with the hash, confirmed", async () => {
    const { d, states } = deps();
    expect(await executeOwnerTx(d, REQ)).toBe(HASH);
    expect(states.map((s) => s.status)).toEqual(["checking", "wallet", "pending", "confirmed"]);
    expect(states[2]).toMatchObject({ status: "pending", hash: HASH });
  });

  it("a 4001 in the wallet says cancelled; anything else never does", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rejected = deps({ write: vi.fn(async () => Promise.reject(Object.assign(new Error("User denied"), { code: 4001 }))) });
    await executeOwnerTx(rejected.d, REQ);
    expect(rejected.states.at(-1)).toMatchObject({ status: "failed", message: TX_MESSAGES.rejected });

    const other = deps({ write: vi.fn(async () => Promise.reject(new Error("something odd"))) });
    await executeOwnerTx(other.d, REQ);
    expect(other.states.at(-1)).toMatchObject({ status: "failed", message: "Transaction failed." });
  });

  it("an account the wallet hasn't connected to this site: says so, names it, and offers Reconnect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const expected = "Your wallet hasn't connected this account to Glance. Open your wallet, connect 0xE5AE…730F to this site, then try again.";
    for (const err of [
      new BaseError("x", { cause: new UnauthorizedProviderError(new Error("The requested account and/or method has not been authorized by the user.")) }),
      Object.assign(new Error("The requested account and/or method has not been authorized by the user."), { code: 4100 }),
      Object.assign(new Error('Account "0xE5AE…" not found for connector "MetaMask".'), { name: "ConnectorAccountNotFoundError" }),
    ]) {
      const { d, states } = deps({ write: vi.fn(async () => Promise.reject(err)) });
      await executeOwnerTx(d, REQ);
      expect(states.at(-1)).toMatchObject({ status: "failed", message: expected, reconnect: true });
    }
    const onReconnect = vi.fn();
    render(<TxStatus state={{ status: "failed", label: "Approve", message: expected, reconnect: true }} onReconnect={onReconnect} />);
    fireEvent.click(screen.getByText("Reconnect"));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("with no account at all: failed with a reason, logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d, states } = deps({ account: undefined });
    await executeOwnerTx(d, REQ);
    expect(states).toEqual([{ status: "failed", label: REQ.label, message: "Transaction failed.", hash: undefined, reconnect: undefined }]);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("step 4's status follows real state", () => {
  const base = { switching: false, lastMode: "setup" as const, runError: null };
  const vaultStatus = (a: ReturnType<typeof activityFor>) =>
    stepStatuses({ connected: true, onChain: true, depositConfirmed: false, extension: false, activity: a }).vault;

  it("Waiting for wallet until there's a hash; Confirming only with one", () => {
    expect(vaultStatus(activityFor({ ...base, running: "setup", tx: { status: "idle" } }))).toBe("waiting-wallet");
    expect(vaultStatus(activityFor({ ...base, running: "setup", tx: { status: "checking" } }))).toBe("waiting-wallet");
    expect(vaultStatus(activityFor({ ...base, running: "setup", tx: { status: "wallet" } }))).toBe("waiting-wallet");
    expect(vaultStatus(activityFor({ ...base, running: "setup", tx: { status: "pending" } }))).toBe("confirming");
  });

  it("a failure, or a run that stopped with a reason, is Failed: never back to Not started", () => {
    expect(vaultStatus(activityFor({ ...base, running: null, tx: { status: "failed" } }))).toBe("failed");
    expect(vaultStatus(activityFor({ ...base, running: null, tx: { status: "idle" }, runError: "Setup stopped" }))).toBe("failed");
  });

  it("an Add more deposit never moves step 4", () => {
    expect(activityFor({ ...base, lastMode: "add-more", running: "add-more", tx: { status: "pending" } })).toEqual({ step: null, phase: "idle" });
    expect(activityFor({ ...base, lastMode: "add-more", running: null, tx: { status: "failed" } })).toEqual({ step: null, phase: "idle" });
  });
});
