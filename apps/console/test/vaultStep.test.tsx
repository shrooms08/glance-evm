/**
 * Step 4 rendered for real: busy disables the button, a funded vault shows a success state with no way to deposit
 * again except the separate "Add more USDG", and the approve is skipped when the allowance covers it.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { zeroAddress, type Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VaultStep, type VaultStepProps } from "../components/VaultStep";
import { demoVaults, stocks, VAULT_SETUP } from "../lib/deployment";
import { addMorePlan, setupPlan, type SetupSnapshot } from "../lib/setup";
import { stepStatuses } from "../lib/setupStatus";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => <a href={href} {...rest}>{children as never}</a> }));

afterEach(cleanup);

const paxos = demoVaults.find((d) => d.key === "paxos")!;
const VAULT = "0xEb7371e40bc863697De3efAbD99e51729D57D3Eb" as Address;
const HASH = `0x15ea${"0".repeat(56)}324a`; // a made-up transaction hash
const NOW = 1_790_300_000;
const configured: SetupSnapshot = {
  owner: "0x03dAC9899f5153fBd9c5EeFEf8E8B46D7f3426CA",
  now: NOW,
  vault: VAULT,
  vaultUsdg: paxos.usdg,
  tokens: stocks.map((s) => ({ approved: true, feed: s.feed, openMaxAge: VAULT_SETUP.openMaxAge, closedMaxAge: VAULT_SETUP.closedMaxAge })),
  routerApproved: true,
  agent: paxos.agent,
  agentExpiry: NOW + 28 * 86_400,
  ownerUsdg: 70_000_000n,
  faucetRemaining: null,
  allowance: 0n,
  factoryAllowance: 0n,
  vaultUsdgBalance: 0n,
};

function props(s: SetupSnapshot, over: Partial<VaultStepProps> = {}): VaultStepProps {
  const status = stepStatuses({
    connected: true,
    onChain: true,
    chain: { eth: 1n, walletUsdg: s.ownerUsdg, snapshot: s, flavour: paxos, usdgDecimals: 6 },
    depositConfirmed: false,
    extension: true,
    activity: { step: null, phase: "idle" },
  }).vault;
  return {
    status,
    progress: { exists: s.vault !== null, configured: true, funded: s.vaultUsdgBalance > 0n },
    plan: setupPlan(s, paxos, 6, 10_000_000n, false, null),
    ready: true,
    busy: false,
    flavour: paxos,
    flavours: demoVaults,
    showFlavourChoice: false,
    onFlavour: () => {},
    vault: s.vault,
    vaultBalance: s.vaultUsdgBalance,
    decimals: 6,
    depositHash: null,
    deposit: { value: "10", error: null, onChange: () => {} },
    addMore: { value: "", error: null, plan: null, onChange: () => {}, onSubmit: () => {} },
    onFinish: () => {},
    runError: null,
    ...over,
  };
}

describe("unfunded vault", () => {
  it("is In progress, offers the first deposit, and Finish setup runs it", () => {
    const onFinish = vi.fn();
    const p = props(configured, { onFinish });
    expect(p.status).toBe("in-progress");
    render(<VaultStep {...p} />);
    expect(screen.getByText(/no deposit yet/)).toBeTruthy();
    expect(screen.getByLabelText("First deposit")).toBeTruthy();
    fireEvent.click(screen.getByText("Finish setup"));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("disables the button while a transaction is waiting or confirming", () => {
    const onFinish = vi.fn();
    render(<VaultStep {...props(configured, { busy: true, onFinish })} />);
    const button = screen.getByText("Working…");
    expect(button.matches(":disabled")).toBe(true);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onFinish).not.toHaveBeenCalled();
    expect((screen.getByLabelText("First deposit") as HTMLInputElement).disabled).toBe(true);
  });

  it("skips the approve when the allowance already covers the deposit", () => {
    render(<VaultStep {...props({ ...configured, allowance: 10_000_000n })} />);
    const todo = screen.getByRole("list", { name: "Still to do" });
    expect(todo.textContent).toContain("Deposit $10 Paxos USDG");
    expect(todo.textContent).not.toContain("Let the vault take");
    expect(screen.getByText("One wallet confirmation.")).toBeTruthy();
  });
});

describe("funded vault", () => {
  const funded = { ...configured, vaultUsdgBalance: 30_000_000n, ownerUsdg: 40_000_000n };

  it("shows success with the deposit's transaction, and no second deposit from Finish setup", () => {
    const onFinish = vi.fn();
    const p = props(funded, { depositHash: HASH, onFinish });
    expect(p.status).toBe("done");
    expect(p.plan).toMatchObject({ steps: [], blocked: null });
    render(<VaultStep {...p} />);
    expect(screen.getByText("Your vault holds $30 Paxos USDG.")).toBeTruthy();
    expect(screen.getByText(/^Deposit 0x15ea…324a/).getAttribute("href")).toBe(`https://explorer.testnet.chain.robinhood.com/tx/${HASH}`);
    expect(screen.queryByText("Finish setup")).toBeNull();
    expect(screen.queryByLabelText("First deposit")).toBeNull();
    expect(screen.queryByText("Can't finish yet")).toBeNull();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("only deposits more through the separate Add more input", () => {
    const onSubmit = vi.fn();
    const empty = props(funded, { addMore: { value: "", error: null, plan: null, onChange: () => {}, onSubmit } });
    const { rerender } = render(<VaultStep {...empty} />);
    expect(screen.getByText("Deposit more").matches(":disabled")).toBe(true);
    const plan = addMorePlan({ ...funded, allowance: 5_000_000n }, paxos, 6, 5_000_000n);
    rerender(<VaultStep {...props(funded, { addMore: { value: "5", error: null, plan, onChange: () => {}, onSubmit } })} />);
    expect(screen.getByText("Deposit $5 Paxos USDG.")).toBeTruthy(); // allowance covers it: no approve
    fireEvent.click(screen.getByText("Deposit more"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps Add more disabled while a transaction is in flight", () => {
    const onSubmit = vi.fn();
    const plan = addMorePlan(funded, paxos, 6, 5_000_000n);
    render(<VaultStep {...props(funded, { busy: true, addMore: { value: "5", error: null, plan, onChange: () => {}, onSubmit } })} />);
    const button = screen.getByText("Deposit more");
    expect(button.matches(":disabled")).toBe(true);
    fireEvent.submit(button.closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("no vault yet", () => {
  it("offers to create it; the USDG choice only in dev mode (?dev=1)", () => {
    const s: SetupSnapshot = { ...configured, vault: null, vaultUsdg: null, tokens: [], routerApproved: false, agent: zeroAddress, agentExpiry: 0 };
    const { rerender } = render(<VaultStep {...props(s)} />);
    expect(screen.getByText("Create my vault")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    rerender(<VaultStep {...props(s, { showFlavourChoice: true })} />);
    expect(screen.getByLabelText(/Paxos USDG/)).toBeTruthy();
  });
});

describe("one-transaction setup", () => {
  const V2 = "0xA76C3E2fe629889D8Bc83b285394eC62673B02E4" as Address;
  const fresh: SetupSnapshot = { ...configured, vault: null, vaultUsdg: null, tokens: [], routerApproved: false, agent: zeroAddress, agentExpiry: 0 };

  it("shows Approve USDG and Create vault, and says 2 wallet prompts before anything starts", () => {
    render(<VaultStep {...props(fresh, { plan: setupPlan(fresh, paxos, 6, 10_000_000n, false, V2), ready: false })} />);
    const todo = screen.getByRole("list", { name: "Still to do" });
    expect(todo.textContent).toContain("Approve USDG");
    expect(todo.textContent).toContain("Create vault: one transaction, configured and funded");
    expect(screen.getByText(/Then 2 wallet prompts\./)).toBeTruthy();
    expect(screen.getByText("Create my vault").matches(":disabled")).toBe(true); // not connected yet
  });

  it("shows the approve as Done and says 1 wallet prompt when the allowance covers the deposit", () => {
    const covered = { ...fresh, factoryAllowance: 10_000_000n };
    const onFinish = vi.fn();
    render(<VaultStep {...props(covered, { plan: setupPlan(covered, paxos, 6, 10_000_000n, false, V2), onFinish })} />);
    expect(screen.getByText("Done: your approval already covers it")).toBeTruthy();
    expect(screen.getByText("1 wallet prompt.")).toBeTruthy();
    fireEvent.click(screen.getByText("Create my vault"));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("disables Create my vault while the approve or the create is in flight", () => {
    const onFinish = vi.fn();
    render(<VaultStep {...props(fresh, { plan: setupPlan(fresh, paxos, 6, 10_000_000n, false, V2), busy: true, onFinish })} />);
    const button = screen.getByText("Working…");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onFinish).not.toHaveBeenCalled();
  });
});
