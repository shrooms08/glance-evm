/**
 * Every onboarding error gets exactly one action, in plain words: Get gas, Get USDG, Switch network, Link Glance,
 * Set up my vault, or Try again.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorActionButton } from "../components/VaultStep";
import { errorAction } from "../lib/errorAction";
import { TX_MESSAGES } from "../lib/txMessages";

afterEach(cleanup);

describe("the one action for an error", () => {
  it("from the error's own words", () => {
    expect(errorAction(TX_MESSAGES.noGas).label).toBe("Get gas");
    expect(errorAction("Not enough Paxos USDG to deposit $10. Claim some at https://faucet.paxos.com/ (Robinhood Chain testnet), or deposit less.").label).toBe("Get USDG");
    expect(errorAction("Your wallet is on another network").label).toBe("Switch network");
    expect(errorAction("The testnet stopped responding.").label).toBe("Try again");
  });

  it("from its code, when there is one", () => {
    expect(errorAction("", "SESSION_EXPIRED").label).toBe("Link Glance");
    expect(errorAction("", "NOT_A_VAULT").label).toBe("Set up my vault");
    expect(errorAction("", "wrong-network").label).toBe("Switch network");
  });

  it("renders exactly one button, which does that one thing", () => {
    const onAction = vi.fn();
    render(<ErrorActionButton message={TX_MESSAGES.noGas} onAction={onAction} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onAction).toHaveBeenCalledWith("get-gas");
  });
});
