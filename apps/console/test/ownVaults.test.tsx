/**
 * The console shows the connected wallet's own vaults and nothing else: no demo vault, no pasted address, no TestUSDG
 * setup, unless ?dev=1. Without a wallet, the vault pages show a clean "Connect your wallet" screen.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VaultGateScreen } from "../components/OwnVaultGate";
import { VaultStep, type VaultStepProps } from "../components/VaultStep";
import { demoVaults } from "../lib/deployment";
import { priceSourceLabel } from "../lib/priceSource";
import { setupFlavourKey, setupPlan, type SetupSnapshot } from "../lib/setup";
import { myVaultsState, selectVault, vaultMenu, type OwnedVault } from "../lib/vault";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => <a href={href} {...rest}>{children as never}</a> }));
afterEach(cleanup);

const A = "0xEb7371e40bc863697De3efAbD99e51729D57D3Eb" as Address;
const B = "0xe359624f0376Be7FBDBD1689925800ED9a0392f5" as Address;
const DEMOS = demoVaults.map((d) => d.address.toLowerCase());
const one: OwnedVault[] = [{ vault: A, factoryVersion: 1 }];
const two: OwnedVault[] = [
  { vault: B, factoryVersion: 2 },
  { vault: A, factoryVersion: 1 },
];

describe("the header's vault control lists only the wallet's own vaults", () => {
  it("0 vaults: no menu", () => {
    expect(vaultMenu([], false)).toEqual({ kind: "none" });
  });

  it("1 vault: no menu, just 'Your vault'", () => {
    expect(vaultMenu(one, false)).toEqual({ kind: "single", option: { address: A, label: "Your vault", note: "Owned by the connected wallet", mine: true } });
  });

  it("2 vaults: a menu of exactly those two, and no address box", () => {
    const menu = vaultMenu(two, false);
    expect(menu.kind).toBe("menu");
    if (menu.kind !== "menu") return;
    expect(menu.options.map((o) => o.address)).toEqual([B, A]);
    expect(menu.options.every((o) => o.mine)).toBe(true);
    expect(menu.paste).toBe(false);
  });

  it("?dev=1 adds the demo vaults and the address box, and only then", () => {
    for (const owned of [[], one, two]) {
      const plain = vaultMenu(owned, false);
      const addresses = plain.kind === "menu" ? plain.options.map((o) => o.address) : plain.kind === "single" ? [plain.option.address] : [];
      expect(addresses.some((a) => DEMOS.includes(a.toLowerCase()))).toBe(false);
    }
    const dev = vaultMenu(one, true);
    expect(dev.kind === "menu" && dev.paste).toBe(true);
    expect(dev.kind === "menu" && dev.options.some((o) => DEMOS.includes(o.address.toLowerCase()))).toBe(true);
  });
});

describe("which vault a page shows", () => {
  it("the wallet's own, never a demo vault as a fallback", () => {
    expect(selectVault(null, [], false)).toBeNull();
    expect(selectVault(demoVaults[0]!.address, [], false)).toBeNull(); // a demo address in the URL doesn't count
    expect(selectVault("0x0000000000000000000000000000000000000001", [A], false)).toBe(A); // not theirs: their own instead
    expect(selectVault(null, [A], false)).toBe(A);
    expect(selectVault(A, [B, A], false)).toBe(A);
  });

  it("?dev=1 allows any vault, and defaults to the demo vault", () => {
    expect(selectVault(null, [], true)).toBe(demoVaults[0]!.address);
    expect(selectVault("0x0000000000000000000000000000000000000001", [], true)).toBe("0x0000000000000000000000000000000000000001");
  });

  it("the wallet's state: no wallet, loading, none, or its vaults", () => {
    expect(myVaultsState({ connected: false, isLoading: false, error: null, owned: [] })).toEqual({ status: "no-wallet" });
    expect(myVaultsState({ connected: true, isLoading: true, error: null, owned: [] })).toEqual({ status: "loading" });
    expect(myVaultsState({ connected: true, isLoading: false, error: null, owned: [] })).toEqual({ status: "none" });
    expect(myVaultsState({ connected: true, isLoading: false, error: null, owned: one })).toEqual({ status: "ready", vaults: one });
  });
});

describe("the vault pages without a vault", () => {
  it("no wallet: a clean 'Connect your wallet' screen, no demo data", () => {
    const onConnect = vi.fn();
    const { container } = render(<VaultGateScreen state={{ status: "no-wallet" }} onConnect={onConnect} startHref="/start" pricesHref="/prices" />);
    expect(screen.getByRole("heading", { name: "Connect your wallet" })).toBeTruthy();
    fireEvent.click(screen.getByText("Connect wallet"));
    expect(onConnect).toHaveBeenCalledTimes(1);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/0x[0-9a-f]{4}/i); // no vault address
    expect(text).not.toMatch(/\$\d/); // no balances
    expect(text).not.toMatch(/demo/i);
    expect(screen.getByText("See live prices").getAttribute("href")).toBe("/prices"); // prices stay public
  });

  it("a wallet with no vault: 'Create your vault', to Get started", () => {
    render(<VaultGateScreen state={{ status: "none" }} startHref="/start" pricesHref="/prices" />);
    expect(screen.getByRole("heading", { name: "You don't have a vault yet" })).toBeTruthy();
    expect(screen.getByText("Create your vault").getAttribute("href")).toBe("/start");
  });
});

describe("Get started is Paxos USDG only", () => {
  const paxos = demoVaults.find((d) => d.key === "paxos")!;
  const fresh: SetupSnapshot = {
    owner: "0xE5AE75Dd9D7130FA4cf80926bab410e1d440730F",
    now: 1_790_230_780,
    vault: null,
    vaultUsdg: null,
    tokens: [],
    routerApproved: false,
    agent: "0x0000000000000000000000000000000000000000",
    agentExpiry: 0,
    ownerUsdg: 100_000_000n,
    faucetRemaining: null,
    allowance: 0n,
    factoryAllowance: 0n,
    vaultUsdgBalance: 0n,
  };
  const props = (over: Partial<VaultStepProps> = {}): VaultStepProps => ({
    status: "not-started",
    progress: { exists: false, configured: false, funded: false },
    plan: setupPlan(fresh, paxos, 6, 50_000_000n, false, "0xA76C3E2fe629889D8Bc83b285394eC62673B02E4"),
    ready: true,
    busy: false,
    flavour: paxos,
    flavours: demoVaults,
    showFlavourChoice: false,
    onFlavour: () => {},
    vault: null,
    vaultBalance: 0n,
    decimals: 6,
    depositHash: null,
    deposit: { value: "50", error: null, onChange: () => {} },
    addMore: { value: "", error: null, plan: null, onChange: () => {}, onSubmit: () => {} },
    onFinish: () => {},
    runError: null,
    ...over,
  });

  it("without ?dev=1: no TestUSDG anywhere, and no developer wording", () => {
    const { container } = render(<VaultStep {...props()} />);
    expect(container.textContent).not.toMatch(/TestUSDG/);
    expect(container.textContent).not.toMatch(/make create-vault/);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(container.textContent).toContain("One transaction creates your vault, already set up");
    expect(setupFlavourKey(false, "test")).toBe("paxos"); // even if something asked for TestUSDG
  });

  it("with ?dev=1: the TestUSDG fallback can be chosen", () => {
    render(<VaultStep {...props({ showFlavourChoice: true })} />);
    expect(screen.getByLabelText("TestUSDG")).toBeTruthy();
    expect(setupFlavourKey(true, "test")).toBe("test");
  });
});

describe("price sources, said plainly", () => {
  it("NFLX is a public quote; the others are Chainlink, mirrored from mainnet", () => {
    expect(priceSourceLabel({ symbol: "NFLX", feedReal: false, kind: "public-quote" }).label).toBe("Public quote (no Chainlink NFLX feed on Robinhood Chain)");
    for (const symbol of ["TSLA", "AMZN", "PLTR", "AMD"]) {
      expect(priceSourceLabel({ symbol, feedReal: false, kind: "mainnet-mirror" }).label).toBe("Chainlink, mirrored from mainnet");
    }
  });
});
