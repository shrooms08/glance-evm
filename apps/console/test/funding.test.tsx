/**
 * Get started, step 3, automatic: polling every 5 seconds until the wallet has gas and USDG; gas and 20 starter USDG
 * sent by the starter fund on their own (the transaction shown while it lands); when the fund is empty or off, the
 * faucet sites with a plain line, still detected automatically; a failed send has one action, Try again.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMPTY_GAS_LINE, EMPTY_USDG_LINE, FundingStep } from "../components/FundingStep";
import { startPollMs } from "../lib/useSetupSnapshot";

afterEach(cleanup);

describe("balance polling", () => {
  const state = (eth: bigint, usdg: bigint, vault = 0n) => ({ eth, usdg: { paxos: usdg, test: 0n }, vaultFlavour: null, snapshot: { vaultUsdgBalance: vault } });
  it("every 5 seconds until there's gas and USDG, then every 15", () => {
    expect(startPollMs(undefined)).toBe(5_000);
    expect(startPollMs(state(0n, 0n))).toBe(5_000);
    expect(startPollMs(state(1n, 0n))).toBe(5_000);
    expect(startPollMs(state(1n, 10n))).toBe(15_000);
    expect(startPollMs(state(1n, 0n, 10n))).toBe(15_000);
  });
});

describe("the funding rows", () => {
  const base = {
    hasEth: false,
    hasUsdg: false,
    usdgKey: "paxos" as const,
    walletUsdg: 0n,
    usdgDecimals: 6,
    source: { gas: "on" as const, usdg: "on" as const },
    connected: true,
    gas: { state: "idle" as const },
    usdg: { state: "idle" as const },
    onGetGas: () => {},
    onGetUsdg: () => {},
  };

  it("with the starter fund: no buttons to press; each send shows while it lands, then the row is done", () => {
    const { rerender } = render(<FundingStep {...base} gas={{ state: "sending" }} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText(/Sending you test ETH/)).toBeTruthy();
    rerender(<FundingStep {...base} hasEth gas={{ state: "sent", txHash: `0x${"ab".repeat(32)}` }} usdg={{ state: "sent", txHash: `0x${"cd".repeat(32)}` }} />);
    expect(screen.getByText(/Test ETH for gas: arrived\./)).toBeTruthy();
    expect(screen.getByText(/On its way/)).toBeTruthy();
    rerender(<FundingStep {...base} hasEth hasUsdg walletUsdg={20_000_000n} />);
    expect(document.querySelectorAll('li[data-ok="true"]')).toHaveLength(2);
  });

  it("the fund empty: the plain line and the faucet site (Paxos: choose Robinhood Chain testnet)", () => {
    render(<FundingStep {...base} source={{ gas: "empty", usdg: "empty" }} />);
    expect(screen.getByText(new RegExp(EMPTY_GAS_LINE.replace(/[.]/g, "\\.")))).toBeTruthy();
    expect(screen.getByText(new RegExp(EMPTY_USDG_LINE.replace(/[.]/g, "\\.")))).toBeTruthy();
    expect(screen.getByRole("link", { name: /faucet.paxos.com/ })).toBeTruthy();
    expect(screen.getByText(/Choose Robinhood Chain testnet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /faucet.testnet.chain.robinhood.com/ })).toBeTruthy();
    expect(EMPTY_USDG_LINE).toBe("Our starter fund is empty right now. Claim from the Paxos faucet instead.");
  });

  it("no starter fund on this API: the faucet sites", () => {
    render(<FundingStep {...base} source={{ gas: "off", usdg: "off" }} />);
    expect(screen.getByRole("link", { name: /faucet.paxos.com/ })).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("a failed send: one action, Try again", () => {
    const onGetUsdg = vi.fn();
    render(<FundingStep {...base} hasEth usdg={{ state: "failed", message: "That didn't go out. Try again in a moment." }} onGetUsdg={onGetUsdg} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Try again"]);
    fireEvent.click(buttons[0]!);
    expect(onGetUsdg).toHaveBeenCalledTimes(1);
  });
});
