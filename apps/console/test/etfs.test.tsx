/**
 * ETFs in the console: a new vault's default config (one-transaction setup) allows SPY and QQQ once their stand-ins are
 * deployed, and not before; the Limits page's "Add SPY and QQQ to your vault" says how many wallet prompts it takes
 * before the first one, sends only what's missing (setTokenApproval, then setTokenFreshness, per ETF), in order, and
 * stops at a refused prompt. No wallet, no transactions.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { zeroAddress, type Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EtfCard } from "../components/EtfCard";
import { demoVaults, etfs as deployedEtfs, etfsIn, stocks, type EtfStock } from "../lib/deployment";
import { etfAddPlan, type EtfTokenState } from "../lib/etfs";
import { consoleVaultConfig } from "../lib/setup";

afterEach(cleanup);

const paxos = demoVaults.find((d) => d.key === "paxos")!;
const SPY: EtfStock = { symbol: "SPY", token: "0x5d7bEAe66da99B88Aa1ACE7C49F72e5AFBd59c02", tokenDecimals: 18, feed: "0xd30ecC9836d4Fa8f27e1Fb037Ee8FF2535dc5f31" };
const QQQ: EtfStock = { symbol: "QQQ", token: "0x1f2676a6f87c516e48f32DD73bE44E910E66350c", tokenDecimals: 18, feed: "0x8831c6e248C95168F165eAA7C70173A3f1bd5413" };
const ETFS = [SPY, QQQ];
const none: EtfTokenState = { approved: false, feed: zeroAddress, openMaxAge: 0, closedMaxAge: 0 };
const done = (e: EtfStock): EtfTokenState => ({ approved: true, feed: e.feed as Address, openMaxAge: 72_000, closedMaxAge: 345_600 });

describe("the ETFs in the deployment record", () => {
  it("none until make deploy-etf-standins records them; today's record has both", () => {
    expect(etfsIn({ TSLA: { token: SPY.token, feed: SPY.feed } })).toEqual([]);
    expect(deployedEtfs.map((e) => e.symbol)).toEqual(["SPY", "QQQ"]); // deployed 25 Sep 2026
  });

  it("read from .stocks.SPY / .stocks.QQQ once recorded", () => {
    expect(etfsIn({ SPY: { token: SPY.token, feed: SPY.feed, tokenDecimals: 18 }, QQQ: { token: QQQ.token, feed: QQQ.feed, tokenDecimals: 18 } })).toEqual(ETFS);
    expect(etfsIn({ SPY: { skipped: true } })).toEqual([]);
  });
});

describe("a new vault's default config", () => {
  const tokensOf = (etfs: EtfStock[]) => consoleVaultConfig(paxos, 6, etfs).tokens.map((t) => t.token);

  it("the five stocks, plus SPY and QQQ once deployed, all with the same 20h / 96h price checks", () => {
    expect(tokensOf([])).toEqual(stocks.map((s) => s.token));
    const config = consoleVaultConfig(paxos, 6, ETFS);
    expect(config.tokens.slice(-2)).toEqual([
      { token: SPY.token, priceFeed: SPY.feed, openMaxAge: 72_000, closedMaxAge: 345_600 },
      { token: QQQ.token, priceFeed: QQQ.feed, openMaxAge: 72_000, closedMaxAge: 345_600 },
    ]);
    expect(config.tokens).toHaveLength(stocks.length + 2);
  });
});

describe("Add SPY and QQQ to your vault", () => {
  it("plans only what's missing: approval with the feed, then freshness, per ETF", () => {
    expect(etfAddPlan(ETFS, [none, none]).map((s) => [s.functionName, s.args])).toEqual([
      ["setTokenApproval", [SPY.token, SPY.feed, true]],
      ["setTokenFreshness", [SPY.token, 72_000, 345_600]],
      ["setTokenApproval", [QQQ.token, QQQ.feed, true]],
      ["setTokenFreshness", [QQQ.token, 72_000, 345_600]],
    ]);
    // SPY already allowed; QQQ approved with an old feed and the right freshness.
    const stale = { ...done(QQQ), feed: "0x0000000000000000000000000000000000000001" as Address };
    expect(etfAddPlan(ETFS, [done(SPY), stale]).map((s) => s.functionName)).toEqual(["setTokenApproval"]);
    expect(etfAddPlan(ETFS, [done(SPY), done(QQQ)])).toEqual([]);
  });

  it("says the prompt count up front, then sends each prompt in order", async () => {
    const send = vi.fn(async () => true);
    render(<EtfCard etfs={ETFS} states={[none, none]} send={send} />);
    expect(screen.getByText(/^4 wallet prompts: Allow SPY with its price feed; Set SPY's price checks/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add SPY and QQQ to your vault" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    expect((send.mock.calls as unknown as Array<[{ functionName: string; args: unknown[] }]>).map(([s]) => `${s.functionName} ${String(s.args[0])}`)).toEqual([
      `setTokenApproval ${SPY.token}`,
      `setTokenFreshness ${SPY.token}`,
      `setTokenApproval ${QQQ.token}`,
      `setTokenFreshness ${QQQ.token}`,
    ]);
  });

  it("stops at a refused prompt (nothing after it is sent)", async () => {
    const send = vi.fn(async () => false);
    render(<EtfCard etfs={ETFS} states={[none, none]} send={send} />);
    fireEvent.click(screen.getByRole("button", { name: /Add SPY and QQQ/ }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("already allowed: says so, no button; not deployed: no card at all", () => {
    render(<EtfCard etfs={ETFS} states={[done(SPY), done(QQQ)]} send={vi.fn()} />);
    expect(screen.getByText("Your vault can buy SPY and QQQ.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    const { container } = render(<EtfCard etfs={[]} states={null} send={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});
