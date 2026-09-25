/** The withdraw card: usable by the owner only; anyone else sees it disabled and why. No wallet, no transactions. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NOT_OWNER_WITHDRAW, WithdrawForm, type WithdrawFormProps } from "../components/WithdrawCard";

afterEach(cleanup);

const base: WithdrawFormProps = {
  reason: null,
  balance: 30_000_000n,
  decimals: 6,
  usdgLabel: "Paxos USDG",
  owner: "0x03dAC9899f5153fBd9c5EeFEf8E8B46D7f3426CA",
  walletUsdg: 40_000_000n,
  tx: { status: "idle" },
  busy: false,
  onWithdraw: () => {},
};

const amount = () => screen.getByLabelText("Amount (Paxos USDG)") as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: /^Withdraw/ });

describe("owner", () => {
  it("withdraws exactly what was typed, in raw USDG", () => {
    const onWithdraw = vi.fn();
    render(<WithdrawForm {...base} onWithdraw={onWithdraw} />);
    expect(submit().matches(":disabled")).toBe(true); // nothing typed yet
    fireEvent.change(amount(), { target: { value: "12.5" } });
    fireEvent.click(submit());
    expect(onWithdraw).toHaveBeenCalledWith(12_500_000n);
    expect(screen.getByText("Your wallet holds $40 Paxos USDG.")).toBeTruthy();
  });

  it("Max fills the vault's whole balance", () => {
    const onWithdraw = vi.fn();
    render(<WithdrawForm {...base} onWithdraw={onWithdraw} />);
    fireEvent.click(screen.getByText("Max"));
    expect(amount().value).toBe("30");
    fireEvent.click(submit());
    expect(onWithdraw).toHaveBeenCalledWith(30_000_000n);
  });

  it("refuses more than the vault holds, zero, and too many decimals, before the wallet opens", () => {
    const onWithdraw = vi.fn();
    render(<WithdrawForm {...base} onWithdraw={onWithdraw} />);
    for (const [value, error] of [
      ["30.01", "That's more than the vault holds."],
      ["0", "Enter an amount above zero."],
      ["1.1234567", "Enter an amount in USDG, up to 6 decimal places."],
    ] as const) {
      fireEvent.change(amount(), { target: { value } });
      expect(screen.getByText(error)).toBeTruthy();
      expect(submit().matches(":disabled")).toBe(true);
    }
    expect(onWithdraw).not.toHaveBeenCalled();
  });

  it("is disabled while a withdrawal is in flight, and shows the transaction with its explorer link", () => {
    const onWithdraw = vi.fn();
    const hash = `0x9045${"0".repeat(56)}1234` as `0x${string}`; // a made-up transaction hash
    render(<WithdrawForm {...base} busy tx={{ status: "pending", label: "Withdraw $10 Paxos USDG", hash }} onWithdraw={onWithdraw} />);
    expect(screen.getByRole("button", { name: "Withdrawing…" }).matches(":disabled")).toBe(true);
    expect(amount().disabled).toBe(true);
    expect(screen.getByText(/on the explorer/).getAttribute("href")).toBe(`https://explorer.testnet.chain.robinhood.com/tx/${hash}`);
  });

  it("says cancelled only when the wallet said so", () => {
    render(<WithdrawForm {...base} tx={{ status: "failed", label: "Withdraw $10 Paxos USDG", message: "Transaction failed." }} />);
    expect(screen.getByText("Transaction failed.")).toBeTruthy();
    expect(screen.queryByText(/cancelled/)).toBeNull();
  });
});

describe("not the owner", () => {
  it("shows the card disabled with the reason", () => {
    const onWithdraw = vi.fn();
    render(<WithdrawForm {...base} reason="not-owner" walletUsdg={undefined} onWithdraw={onWithdraw} />);
    expect(screen.getByText(NOT_OWNER_WITHDRAW)).toBeTruthy();
    expect(NOT_OWNER_WITHDRAW).toBe("Only the vault owner can withdraw");
    expect(amount().disabled).toBe(true);
    expect(screen.getByText("Max").matches(":disabled")).toBe(true);
    expect(submit().matches(":disabled")).toBe(true);
    fireEvent.submit(submit().closest("form")!);
    expect(onWithdraw).not.toHaveBeenCalled();
  });

  it("asks to connect or switch network when that's the problem instead", () => {
    const onSwitchNetwork = vi.fn();
    const { rerender } = render(<WithdrawForm {...base} reason="no-wallet" />);
    expect(screen.getByText("Connect the owner's wallet to withdraw.")).toBeTruthy();
    rerender(<WithdrawForm {...base} reason="wrong-network" onSwitchNetwork={onSwitchNetwork} />);
    fireEvent.click(screen.getByText("Switch network"));
    expect(onSwitchNetwork).toHaveBeenCalledTimes(1);
    expect(submit().matches(":disabled")).toBe(true);
  });
});
