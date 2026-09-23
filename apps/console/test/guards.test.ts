/**
 * Guard wording: the console says the API's own sentences (packages/core/src/errors.ts, pinned by the API's tests) and
 * never "something went wrong".
 */
import { glanceVaultAbi } from "@glance/core/abi";
import { RPC_TROUBLE_MESSAGE } from "@glance/core/rpc";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, HttpRequestError, InsufficientFundsError, UserRejectedRequestError } from "viem";
import { describe, expect, it } from "vitest";

import type { ActivityItem } from "../lib/api";
import { foldOwnerRuns } from "../lib/activity";
import { guardCounts, guardLabel } from "../lib/guards";
import { describeTxError, isUserRejection, TX_MESSAGES } from "../lib/txMessages";

const reverted = (errorName: string, args: readonly unknown[] = []) => {
  const data = encodeErrorResult({ abi: glanceVaultAbi, errorName: errorName as never, args: args as never });
  return new BaseError("reverted", { cause: new ContractFunctionRevertedError({ abi: glanceVaultAbi, data, functionName: "setLimits" }) });
};

describe("an owner's transaction that doesn't go through", () => {
  it("says the vault's own sentence when the vault refuses", () => {
    expect(describeTxError(reverted("InvalidLimits"), { usdgDecimals: 6 })).toBe(
      "Those limits don't fit together: the per-trade limit must be above zero and no bigger than either daily limit.",
    );
    expect(describeTxError(reverted("NotOwner"), { usdgDecimals: 6 })).toBe("Only the vault owner can do that. I can trade, but I can never move your money out.");
    expect(describeTxError(reverted("InvalidAgentExpiry", [1n]), { usdgDecimals: 6 })).toBe("An agent's permission has to end in the future and last at most 30 days.");
  });

  it("says plainly when the owner cancelled, and that nothing changed", () => {
    expect(describeTxError(new BaseError("x", { cause: new UserRejectedRequestError(new Error("User rejected the request.")) }), { usdgDecimals: 6 })).toBe(TX_MESSAGES.rejected);
    expect(describeTxError({ code: 4001, message: "User denied transaction signature" }, { usdgDecimals: 6 })).toBe(TX_MESSAGES.rejected);
  });

  it("says cancelled ONLY for code 4001 or UserRejectedRequestError, wherever it sits in the cause chain", () => {
    const walletError = Object.assign(new Error("MetaMask Tx Signature: User denied transaction signature."), { code: 4001 });
    expect(describeTxError(new BaseError("Request failed", { cause: new BaseError("inner", { cause: walletError }) }), { usdgDecimals: 6 })).toBe(TX_MESSAGES.rejected);
    // Words that sound like a rejection, without the code, are not one.
    expect(describeTxError(new Error("User denied something"), { usdgDecimals: 6 })).toBe("Transaction failed.");
    expect(describeTxError({ code: -32603, message: "Internal JSON-RPC error." }, { usdgDecimals: 6 })).toBe("Transaction failed.");
    expect(isUserRejection({ code: 4100 })).toBe(false);
  });

  it("gives the real reason otherwise: a plain revert reason, no gas, or just Transaction failed", () => {
    const reason = new BaseError("x", { cause: new ContractFunctionRevertedError({ abi: glanceVaultAbi, message: "execution reverted: ERC20: insufficient allowance", functionName: "deposit" }) });
    expect(describeTxError(reason, { usdgDecimals: 6 })).toBe("ERC20: insufficient allowance");
    const gas = new BaseError("x", { cause: new InsufficientFundsError() });
    expect(describeTxError(gas, { usdgDecimals: 6 })).toBe(TX_MESSAGES.noGas);
    expect(describeTxError(new Error("estimateGas failed"), { usdgDecimals: 6 })).toBe("Transaction failed.");
  });

  it("uses the API's testnet wording when the RPC is the problem", () => {
    const err = new HttpRequestError({ url: "https://rpc.testnet.chain.robinhood.com", details: "fetch failed" });
    expect(describeTxError(err, { usdgDecimals: 6 })).toBe(RPC_TROUBLE_MESSAGE);
    expect(RPC_TROUBLE_MESSAGE).toBe("The Robinhood Chain testnet isn't responding right now. Trying again…");
  });
});

describe("guards that fired", () => {
  it("counts them, most frequent first, with short names", () => {
    expect(guardCounts(["PER_TRADE_CAP", "PAUSED", "PER_TRADE_CAP", "SOMETHING_NEW"])).toEqual([
      { code: "PER_TRADE_CAP", label: "Per-trade cap", count: 2 },
      { code: "SOMETHING_NEW", label: "Other", count: 1 },
      { code: "PAUSED", label: "Paused", count: 1 },
    ]);
    expect(guardLabel("DAILY_BUY_CAP")).toBe("24h buy cap");
  });
});

describe("the activity timeline", () => {
  const item = (kind: ActivityItem["kind"], n: number): ActivityItem => ({
    type: kind,
    kind,
    summary: `${kind} ${n}`,
    txHash: `0x${n}`,
    logIndex: n,
    timestamp: 1_000 - n,
    explorerUrl: null,
    data: {},
  });

  it("folds a long run of owner changes, never a trade or a refusal", () => {
    const items = [item("refusal", 0), item("trade", 1), ...[2, 3, 4, 5, 6].map((n) => item("owner", n)), item("trade", 7), item("owner", 8)];
    const folded = foldOwnerRuns(items);
    expect(folded.map((e) => (Array.isArray(e) ? `run(${e.length})` : e.kind))).toEqual(["refusal", "trade", "run(5)", "trade", "owner"]);
  });
});
