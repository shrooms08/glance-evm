/**
 * The write gate: not the owner, or on the wrong network, means every control is off and the page says exactly why.
 * Rendered for real (React DOM in jsdom); no wallet, no transactions.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GateNotice, gateReason, WriteGate } from "../components/WriteGate";

const OWNER = "0xca6A40275A2A6171a7338FCa56Cf4d714C97aDFF" as Address;
const STRANGER = "0x1234567890123456789012345678901234567890" as Address;

afterEach(cleanup);

function Controls({ reason }: { reason: ReturnType<typeof gateReason> }) {
  return (
    <WriteGate reason={reason}>
      <button>Save limits</button>
      <button role="switch" aria-checked="true" aria-label="Pause trading" />
      <input aria-label="Per trade" defaultValue="100" />
    </WriteGate>
  );
}

describe("gateReason", () => {
  it("opens only for the owner, connected, on chain 46630", () => {
    const base = { isConnected: true, walletChainId: 46_630, expectedChainId: 46_630, account: OWNER, owner: OWNER };
    expect(gateReason(base)).toBeNull();
    expect(gateReason({ ...base, account: STRANGER })).toBe("not-owner");
    expect(gateReason({ ...base, walletChainId: 1 })).toBe("wrong-network");
    expect(gateReason({ ...base, isConnected: false, account: undefined })).toBe("no-wallet");
    expect(gateReason({ ...base, owner: undefined })).toBe("loading");
    // Checksum case doesn't matter.
    expect(gateReason({ ...base, account: OWNER.toLowerCase() as Address })).toBeNull();
  });
});

describe("not the owner", () => {
  it("disables every control and says whose vault it is", () => {
    render(
      <>
        <GateNotice reason="not-owner" owner={OWNER} account={STRANGER} />
        <Controls reason="not-owner" />
      </>,
    );
    expect(screen.getByText("You're not this vault's owner, so the controls are off")).toBeTruthy();
    expect(screen.getByText("0xca6A…aDFF")).toBeTruthy();
    expect(screen.getByText("0x1234…7890")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("the vault itself refuses anyone else");
    for (const el of [screen.getByText("Save limits"), screen.getByRole("switch"), screen.getByLabelText("Per trade")]) {
      expect((el as HTMLButtonElement).matches(":disabled")).toBe(true);
    }
  });
});

describe("wrong network", () => {
  it("disables the controls and switches (adding the network) in one click", () => {
    const onSwitch = vi.fn();
    render(
      <>
        <GateNotice reason="wrong-network" onSwitchNetwork={onSwitch} />
        <Controls reason="wrong-network" />
      </>,
    );
    expect(screen.getByText("Your wallet is on another network")).toBeTruthy();
    expect(screen.getByText(/Robinhood Chain testnet \(chain 46630\)/)).toBeTruthy();
    fireEvent.click(screen.getByText("Switch to Robinhood Chain testnet"));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Save limits").matches(":disabled")).toBe(true);
  });

  it("says when the wallet is busy switching", () => {
    render(<GateNotice reason="wrong-network" onSwitchNetwork={() => {}} switching />);
    expect(screen.getByText("Check your wallet…").matches(":disabled")).toBe(true);
  });
});

describe("the owner, on the right network", () => {
  it("sees no notice and working controls", () => {
    const { container } = render(
      <>
        <GateNotice reason={null} />
        <Controls reason={null} />
      </>,
    );
    expect(container.querySelector(".notice")).toBeNull();
    expect(screen.getByText("Save limits").matches(":disabled")).toBe(false);
  });
});
