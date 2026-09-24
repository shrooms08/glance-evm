/**
 * Get started, step 3, balance-aware: polling every 5 seconds until the wallet has gas and USDG (then every 15), "Get
 * gas" only when Glance's faucet is on (the public faucet link otherwise), the transaction shown while it lands, and
 * each row ticking itself when the funds arrive. Rendered for real; no wallet, no network.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FundingStep } from "../components/FundingStep";
import { startPollMs } from "../lib/useSetupSnapshot";

afterEach(cleanup);

describe("balance polling", () => {
  const state = (eth: bigint, usdg: bigint, vault = 0n) => ({ eth, usdg: { paxos: usdg, test: 0n }, vaultFlavour: null, snapshot: { vaultUsdgBalance: vault } });
  it("every 5 seconds until there's gas and USDG, then every 15", () => {
    expect(startPollMs(undefined)).toBe(5_000);
    expect(startPollMs(state(0n, 0n))).toBe(5_000);
    expect(startPollMs(state(1n, 0n))).toBe(5_000);
    expect(startPollMs(state(1n, 10n))).toBe(15_000);
    // USDG already in the vault counts.
    expect(startPollMs(state(1n, 0n, 10n))).toBe(15_000);
  });
});

describe("the funding rows", () => {
  const base = { hasEth: false, hasUsdg: false, usdgKey: "paxos" as const, walletUsdg: 0n, usdgDecimals: 6, connected: true, gas: { state: "idle" as const }, onGetGas: () => {} };

  it("'Get gas' when Glance's faucet is on", () => {
    const onGetGas = vi.fn();
    render(<FundingStep {...base} faucet onGetGas={onGetGas} />);
    fireEvent.click(screen.getByRole("button", { name: "Get gas" }));
    expect(onGetGas).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/faucet.testnet.chain.robinhood.com/)).toBeNull();
  });

  it("no faucet here: no button, the public faucet link instead", () => {
    render(<FundingStep {...base} faucet={false} />);
    expect(screen.queryByRole("button", { name: "Get gas" })).toBeNull();
    expect(screen.getByRole("link", { name: /faucet.testnet.chain.robinhood.com/ })).toBeTruthy();
  });

  it("sent: the transaction, until the balance shows it; then the row is done", () => {
    const { rerender } = render(<FundingStep {...base} faucet gas={{ state: "sent", txHash: `0x${"ab".repeat(32)}` }} />);
    expect(screen.getByText(/On its way/)).toBeTruthy();
    rerender(<FundingStep {...base} faucet hasEth gas={{ state: "sent", txHash: `0x${"ab".repeat(32)}` }} />);
    expect(screen.getByText(/Test ETH for gas: arrived\./)).toBeTruthy();
    expect(document.querySelectorAll('li[data-ok="true"]')).toHaveLength(1);
  });

  it("Paxos USDG: the faucet link and which network to pick, until it arrives", () => {
    const { rerender } = render(<FundingStep {...base} faucet={false} />);
    expect(screen.getByRole("link", { name: /faucet.paxos.com/ })).toBeTruthy();
    expect(screen.getByText(/choose Robinhood Chain testnet/)).toBeTruthy();
    rerender(<FundingStep {...base} faucet={false} hasUsdg walletUsdg={10_000_000n} />);
    expect(screen.getByText(/arrived\./)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /faucet.paxos.com/ })).toBeNull();
  });

  it("the faucet failed: said plainly, with the public faucet as the way on", () => {
    render(<FundingStep {...base} faucet gas={{ state: "failed", message: "Glance's gas faucet is used up for today. Try the public faucet." }} />);
    expect(screen.getByText("No gas sent")).toBeTruthy();
    expect(screen.getByRole("link", { name: /faucet.testnet.chain.robinhood.com/ })).toBeTruthy();
  });
});
