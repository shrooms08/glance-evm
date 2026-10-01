/**
 * Wallets that can't reach Robinhood Chain testnet (lib/walletSupport.ts, components/WalletProblem.tsx): Phantom is
 * recognised by every way it shows itself and is never asked to switch; any switch that fails, or never answers, says
 * so with the wallets that work; MetaMask's path is unchanged. No wallet, no transactions.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WalletProblem } from "../components/WalletProblem";
import {
  isPhantom,
  PHANTOM_MESSAGE,
  SUPPORTED_WALLETS_LINE,
  SWITCH_DECLINED_MESSAGE,
  SWITCH_FAILED_MESSAGE,
  switchToRobinhood,
  WALLET_INSTALL,
  walletErrorCode,
} from "../lib/walletSupport";

afterEach(cleanup);

const metaMask = { id: "io.metamask", name: "MetaMask", rdns: "io.metamask", provider: { isMetaMask: true } };

describe("Phantom, by every way it shows itself", () => {
  const phantomProvider = { isPhantom: true };
  it.each([
    ["the connector's name", { name: "Phantom" }, {}],
    ["the connector's id", { id: "app.phantom" }, {}],
    ["the EIP-6963 rdns", { name: "Injected", rdns: "app.phantom" }, {}],
    ["the EIP-6963 rdns list", { name: "Injected", rdns: ["com.example", "app.phantom"] }, {}],
    ["the provider's isPhantom flag", { name: "Injected", provider: phantomProvider }, {}],
    ["window.phantom.ethereum", { name: "Injected", provider: { request() {} } }, "phantom"],
    ["window.ethereum.isPhantom", { name: "Injected", provider: "eth" }, "ethereum"],
  ])("via %s", (_, wallet, where) => {
    const provider = where === "phantom" ? (wallet as { provider: unknown }).provider : where === "ethereum" ? { isPhantom: true, request() {} } : (wallet as { provider?: unknown }).provider;
    const win = where === "phantom" ? { phantom: { ethereum: provider } } : where === "ethereum" ? { ethereum: provider } : {};
    expect(isPhantom({ ...wallet, provider }, win)).toBe(true);
  });

  it("MetaMask, Rabby and Brave are not Phantom (even with Phantom installed beside them)", () => {
    const win = { phantom: { ethereum: { isPhantom: true } }, ethereum: { isMetaMask: true } };
    expect(isPhantom(metaMask, win)).toBe(false);
    expect(isPhantom({ id: "io.rabby", name: "Rabby Wallet", rdns: "io.rabby", provider: { isRabby: true } }, win)).toBe(false);
    expect(isPhantom({ id: "com.brave.wallet", name: "Brave Wallet", provider: { isBraveWallet: true } }, win)).toBe(false);
  });
});

describe("switching to Robinhood Chain testnet", () => {
  it("Phantom: the card, and the wallet is never asked to switch", async () => {
    const switchChain = vi.fn(async () => undefined);
    const log = vi.fn();
    const out = await switchToRobinhood({ wallet: { name: "Phantom" }, switchChain, log });
    expect(out).toEqual({ kind: "phantom", message: PHANTOM_MESSAGE });
    expect(switchChain).not.toHaveBeenCalled();
    expect(log.mock.calls[0]![0]).toContain("wallet Phantom");
  });

  it.each([
    ["4902 (unknown chain, and the add failed)", { code: 4902 }],
    ["4200 (method not supported)", { code: 4200 }],
    ["-32601 (method not found)", { code: -32601 }],
    ["a code wrapped in a cause", Object.assign(new Error("Switch chain failed"), { cause: { code: 4902 } })],
    ["any thrown error, with no code", new Error("Something odd")],
  ])("a switch that fails with %s says the wallet couldn't, and which wallets work", async (_, error) => {
    const log = vi.fn();
    const out = await switchToRobinhood({ wallet: { name: "Some Wallet" }, switchChain: async () => Promise.reject(error), log });
    expect(out).toMatchObject({ kind: "failed", message: SWITCH_FAILED_MESSAGE });
    expect(log.mock.calls[0]![0]).toMatch(/^\[glance\] wallet Some Wallet couldn't switch to Robinhood Chain testnet \(code /);
  });

  it("a wallet that never answers is a failure too (no spinner forever)", async () => {
    vi.useFakeTimers();
    const pending = switchToRobinhood({ wallet: { name: "Quiet" }, switchChain: () => new Promise(() => {}), log: () => {}, timeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await pending).toMatchObject({ kind: "failed", message: SWITCH_FAILED_MESSAGE, code: "timeout" });
    vi.useRealTimers();
  });

  it("the user declining it (4001) is said as that, not as a wallet that can't", async () => {
    const out = await switchToRobinhood({ wallet: metaMask, switchChain: async () => Promise.reject({ code: 4001 }), log: () => {} });
    expect(out).toMatchObject({ kind: "failed", message: SWITCH_DECLINED_MESSAGE });
  });

  it("MetaMask: the switch is asked for once and goes through, as before", async () => {
    const switchChain = vi.fn(async () => ({ id: 46630 }));
    expect(await switchToRobinhood({ wallet: metaMask, win: { phantom: { ethereum: {} } }, switchChain })).toEqual({ kind: "switched" });
    expect(switchChain).toHaveBeenCalledOnce();
  });

  it("finds the wallet's error code however it's wrapped", () => {
    expect(walletErrorCode({ code: 4902 })).toBe(4902);
    expect(walletErrorCode({ cause: { cause: { code: -32601 } } })).toBe(-32601);
    expect(walletErrorCode(new Error("x"))).toBeNull();
  });
});

describe("the card", () => {
  it("says why, links the official MetaMask and Rabby installs, and reopens the wallet picker", () => {
    const tryAnother = vi.fn();
    render(<WalletProblem message={PHANTOM_MESSAGE} onTryDifferentWallet={tryAnother} />);
    expect(screen.getByRole("alert").textContent).toContain(PHANTOM_MESSAGE);
    expect(screen.getByRole("link", { name: "Get MetaMask" }).getAttribute("href")).toBe(WALLET_INSTALL.metamask);
    expect(screen.getByRole("link", { name: "Get Rabby" }).getAttribute("href")).toBe(WALLET_INSTALL.rabby);
    fireEvent.click(screen.getByRole("button", { name: "Try a different wallet" }));
    expect(tryAnother).toHaveBeenCalledOnce();
  });

  it("the copy has no dashes", () => {
    for (const s of [PHANTOM_MESSAGE, SWITCH_FAILED_MESSAGE, SWITCH_DECLINED_MESSAGE, SUPPORTED_WALLETS_LINE]) expect(s).not.toMatch(/[‒-―]/);
  });
});
