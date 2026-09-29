/**
 * These strings are what the extension, the console and the demo video say. They are pinned exactly on purpose.
 */
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  zeroAddress,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import { glanceVaultAbi } from "../../src/abi.generated.js";
import {
  allErrorsAbi,
  decodeRevert,
  explainRevert,
  revertDataFromError,
  type ExplainContext,
} from "../../src/errors.js";

const NOW = 1_790_000_000;
const H = 3600;
const TSLA: Address = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";
const USDG: Address = "0x231504A1abC63BefC7FFa9930EB085b448b3375E";
const usd = (n: number) => BigInt(Math.round(n * 1e6));

const base: ExplainContext = {
  usdgDecimals: 6,
  now: NOW,
  side: "buy",
  marketState: "OPEN",
  symbol: "TSLA",
  tokenDecimals: 18,
  tokens: { [TSLA.toLowerCase()]: { symbol: "TSLA", decimals: 18 } },
  usdgAddress: USDG,
};

function explain(errorName: string, args: readonly unknown[], ctx: Partial<ExplainContext> = {}) {
  const raw = encodeErrorResult({ abi: allErrorsAbi, errorName, args } as never) as Hex;
  const decoded = decodeRevert(raw);
  expect(decoded?.name).toBe(errorName);
  return explainRevert(decoded, { ...base, ...ctx });
}

describe("per-trade cap", () => {
  it("offers the cap as a buy", () => {
    const e = explain("ExceedsPerTradeCap", [usd(150), usd(100)]);
    expect(e.code).toBe("PER_TRADE_CAP");
    expect(e.message).toBe("That's over your $100 per trade limit. Want me to buy $100 instead?");
    expect(e.detail).toMatchObject({ requested: "150000000", limit: "100000000", over: "50000000", suggestedAmount: "100000000" });
    expect(e.args).toEqual({ notional: "150000000", cap: "100000000" });
  });

  it("names the closed-market cap", () => {
    expect(explain("ExceedsPerTradeCap", [usd(100), usd(25)], { marketState: "CLOSED" }).message).toBe(
      "That's over your $25 per trade limit while the market's closed. Want me to buy $25 instead?",
    );
  });

  it("offers a sell in dollar terms, the rule first", () => {
    expect(explain("ExceedsPerTradeCap", [usd(1900.5), usd(100)], { side: "sell" }).message).toBe(
      "Each trade is capped at $100. Want me to sell $100 worth instead?",
    );
  });

  it("a sell while the market is closed says why the cap is lower", () => {
    const e = explain("ExceedsPerTradeCap", [usd(40), usd(25)], { side: "sell", marketState: "CLOSED" });
    expect(e.message).toBe("The market is closed, so each trade is capped at $25. Want me to sell $25 worth instead?");
    expect(e.detail.suggestedAmountFormatted).toBe("$25");
  });

  it("does not offer a zero-dollar trade when closed-market trading is off", () => {
    const e = explain("ExceedsPerTradeCap", [usd(1), 0n], { marketState: "CLOSED" });
    expect(e.message).toBe("This vault doesn't allow trading while the market's closed.");
    expect(e.detail.suggestedAmount).toBeUndefined();
  });

  it("formats 18-decimal USDG with its real decimals", () => {
    expect(explain("ExceedsPerTradeCap", [150n * 10n ** 18n, 100n * 10n ** 18n], { usdgDecimals: 18 }).message).toBe(
      "That's over your $100 per trade limit. Want me to buy $100 instead?",
    );
  });
});

describe("daily caps", () => {
  const window = [
    { timestamp: NOW - 21 * H, amount: usd(100) }, // frees in 3 hours
    { timestamp: NOW - 2 * H, amount: usd(400) },
  ];

  it("says when a used-up limit frees up", () => {
    const e = explain("ExceedsDailyCap", [usd(500), usd(50), usd(500)], { buyWindow: window });
    expect(e.code).toBe("DAILY_BUY_CAP");
    expect(e.message).toBe("You've used your daily limit. It frees up in 3 hours.");
    expect(e.detail.retryAfterSeconds).toBe(3 * H);
  });

  it("offers what is left when some of the limit remains", () => {
    const partial = [
      { timestamp: NOW - 21 * H, amount: usd(100) },
      { timestamp: NOW - 2 * H, amount: usd(380) },
    ];
    const e = explain("ExceedsDailyCap", [usd(480), usd(50), usd(500)], { buyWindow: partial });
    expect(e.message).toBe(
      "You have $20 left of your $500 daily limit. Want me to buy $20 instead? The rest frees up in 3 hours.",
    );
    expect(e.detail.suggestedAmount).toBe("20000000");
  });

  it("handles the sell limit, and a missing window", () => {
    const e = explain("ExceedsDailySellCap", [usd(500), usd(10), usd(500)], { side: "sell" });
    expect(e.code).toBe("DAILY_SELL_CAP");
    expect(e.message).toBe("Sells are capped at $500 a day, and you've sold that much. It frees up within 24 hours.");
  });

  it("a sell with some of the day's sell cap left, the market closed", () => {
    const e = explain("ExceedsDailySellCap", [usd(100), usd(40), usd(125)], { side: "sell", marketState: "CLOSED" });
    expect(e.message).toBe("The market is closed, so sells are capped at $125 a day. You have $25 left. Want me to sell $25 worth instead? The rest frees up within 24 hours.");
    expect(e.detail.suggestedAmount).toBe("25000000");
  });

  it("mentions the closed market", () => {
    // Closed-market daily cap is 25% of $500 = $125; the $100 buy from 21 hours ago frees up in 3 hours.
    const closedWindow = [
      { timestamp: NOW - 21 * H, amount: usd(100) },
      { timestamp: NOW - 2 * H, amount: usd(25) },
    ];
    const e = explain("ExceedsDailyCap", [usd(125), usd(10), usd(125)], { marketState: "CLOSED", buyWindow: closedWindow });
    expect(e.message).toBe("You've used your daily limit while the market's closed. It frees up in 3 hours.");
  });
});

describe("oracle and market", () => {
  it("refuses a stale price and says how old it is", () => {
    expect(explain("OracleStale", [BigInt(NOW - 14 * H)]).message).toBe(
      "The market's closed and the price is 14 hours old, so I'm not trading on it.",
    );
    expect(explain("OracleStale", [BigInt(NOW - 4 * 86_400)]).message).toBe(
      "The market's closed and the price is 4 days old, so I'm not trading on it.",
    );
  });

  it("refuses a bad price", () => {
    expect(explain("InvalidOraclePrice", [-1n]).code).toBe("ORACLE_BAD_PRICE");
  });

  it("explains the sequencer checks", () => {
    expect(explain("SequencerDown", []).message).toBe(
      "The network's sequencer is down, so prices can't be trusted right now. I'll wait until it's back.",
    );
    expect(explain("SequencerGracePeriod", [BigInt(NOW + 40 * 60)]).message).toBe(
      "The network just came back from an outage. I'll trust prices again in 40 minutes.",
    );
  });
});

describe("permissions and configuration", () => {
  it("agent expired", () => {
    expect(explain("AgentExpired", [BigInt(NOW - 2 * H)]).message).toBe(
      "My permission to trade for you expired 2 hours ago. Renew it in the console and I can carry on.",
    );
  });

  it("not the agent", () => {
    expect(explain("NotAgent", [zeroAddress]).code).toBe("NOT_AGENT");
  });

  it("paused", () => {
    expect(explain("VaultPaused", []).message).toBe(
      "Trading is paused on this vault. Unpause it in the console to let me trade.",
    );
  });

  it("token not approved, named by symbol", () => {
    expect(explain("TokenNotApproved", [TSLA]).message).toBe(
      "TSLA isn't on this vault's approved list, so I can't trade it.",
    );
  });

  it("router not approved", () => {
    expect(explain("RouterNotApproved", [zeroAddress]).message).toBe(
      "This vault hasn't approved the trading desk, so I can't place the order.",
    );
  });

  it("not owner", () => {
    const e = explain("NotOwner", []);
    expect(e.code).toBe("NOT_OWNER");
    expect(e.message).toBe("Only the vault owner can do that. I can trade, but I can never move your money out.");
  });
});

describe("price and fill guards", () => {
  it("slippage, with how far outside the limit", () => {
    const e = explain("SlippageTooHigh", [992n, 1000n]);
    expect(e.code).toBe("SLIPPAGE");
    expect(e.message).toBe("That price is 0.8% outside your slippage limit, so I didn't trade.");
  });

  it("short fill", () => {
    expect(explain("InsufficientOutput", [1n, 2n]).code).toBe("SHORT_FILL");
  });

  it("trade buffer full", () => {
    expect(explain("SpendBufferFull", [BigInt(NOW + 2 * H)]).message).toBe(
      "You've made 32 trades in the last 24 hours, the most this vault allows. The next one frees up in 2 hours.",
    );
  });

  it("insufficient balance, buying and selling", () => {
    expect(explain("InsufficientBalance", [usd(12.5), usd(50)]).message).toBe(
      "You only have $12.50 in the vault. Add funds or buy less.",
    );
    expect(explain("InsufficientBalance", [65_500_000_000_000_000n, 10n ** 18n], { side: "sell" }).message).toBe(
      "You only hold 0.0655 TSLA in the vault.",
    );
  });
});

describe("desk errors bubbled through the vault", () => {
  it("names the token the desk is short of", () => {
    expect(explain("InsufficientInventory", [TSLA, 5n * 10n ** 17n, 10n ** 18n]).message).toBe(
      "The trading desk only has 0.5 TSLA left. Try a smaller buy.",
    );
    expect(explain("InsufficientInventory", [USDG, usd(40), usd(100)], { side: "sell" }).message).toBe(
      "The trading desk only has $40 left to pay out right now. Try a smaller sale.",
    );
  });

  it("stale desk price and moved price", () => {
    expect(explain("StalePrice", [TSLA, BigInt(NOW - 4 * 86_400)]).message).toBe(
      "The desk's price for TSLA is 4 days old, so it won't quote.",
    );
    expect(explain("BelowMinOut", [1n, 2n]).code).toBe("DESK_PRICE_MOVED");
  });
});

describe("decoding", () => {
  it("returns null for empty or unknown data, and explains that as UNKNOWN", () => {
    expect(decodeRevert("0x")).toBeNull();
    expect(decodeRevert(undefined)).toBeNull();
    expect(decodeRevert("0xdeadbeef")).toBeNull();
    const e = explainRevert(null, base);
    expect(e.code).toBe("UNKNOWN");
    expect(e.message).toBe("The chain rejected that for a reason I don't recognise, so nothing moved.");
  });

  it("pulls revert data out of a viem simulation error", () => {
    const raw = encodeErrorResult({ abi: glanceVaultAbi, errorName: "VaultPaused" });
    const cause = new ContractFunctionRevertedError({ abi: glanceVaultAbi, data: raw, functionName: "buy" });
    const err = new ContractFunctionExecutionError(cause, { abi: glanceVaultAbi, functionName: "buy", args: [] });
    expect(revertDataFromError(err)).toBe(raw);
    expect(decodeRevert(revertDataFromError(err))?.name).toBe("VaultPaused");
    expect(revertDataFromError(new Error("boom"))).toBeNull();
  });

  it("gives every custom error the contracts can raise a specific code", () => {
    const sample = (p: AbiParameter): unknown => {
      if (p.type === "address") return zeroAddress;
      if (p.type === "bool") return false;
      if (p.type === "string") return "";
      if (p.type.startsWith("bytes")) return `0x${"00".repeat(Number(p.type.slice(5)) || 0)}`;
      return 1n;
    };
    const errors = allErrorsAbi.filter((i) => i.type === "error");
    expect(errors.length).toBeGreaterThan(40);
    for (const item of errors) {
      if (item.type !== "error") continue;
      const e = explain(item.name, item.inputs.map(sample));
      expect(e.code, item.name).not.toBe("UNKNOWN");
      expect(e.message.length, item.name).toBeGreaterThan(10);
    }
  });
});
