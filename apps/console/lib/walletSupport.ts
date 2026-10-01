/**
 * Wallets that can't reach Robinhood Chain testnet. Phantom supports only its own list of EVM networks and can't add
 * one, so it can never switch to chain 46630: it's recognised before any switch is asked for, and the user is shown
 * which wallets work instead. For any other wallet, a switch that fails (or never answers) says so plainly: never a
 * spinner, never a silent stop.
 */

export const SUPPORTED_WALLETS_LINE = "Works with MetaMask, Rabby or Brave Wallet.";
export const PHANTOM_MESSAGE = "Phantom can't connect to Robinhood Chain yet. Use MetaMask, Rabby or Brave Wallet to set up Glance.";
export const SWITCH_FAILED_MESSAGE = "Your wallet couldn't switch to Robinhood Chain testnet. Use MetaMask, Rabby or Brave Wallet.";
export const SWITCH_DECLINED_MESSAGE = "You declined the switch to Robinhood Chain testnet. Press Add and switch to try again.";
/** The official install pages. */
export const WALLET_INSTALL = { metamask: "https://metamask.io/download/", rabby: "https://rabby.io/" } as const;
/** A switch with no answer from the wallet in this long is treated as failed. */
export const SWITCH_TIMEOUT_MS = 30_000;

/** What's known about the connected wallet: wagmi's connector (id, name, EIP-6963 rdns) and its provider. */
export interface WalletInfo {
  id?: string | null;
  name?: string | null;
  /** The EIP-6963 announcement's reverse domain ("app.phantom"). */
  rdns?: string | readonly string[] | null;
  provider?: unknown;
}

/** The page's own globals Phantom puts there (window.phantom.ethereum, window.ethereum.isPhantom). */
export interface WalletWindow {
  phantom?: { ethereum?: unknown };
  ethereum?: unknown;
}

const named = (s: unknown) => typeof s === "string" && /phantom/i.test(s);

/** Whether the chosen wallet is Phantom, by any of the ways it shows itself. */
export function isPhantom(w: WalletInfo, win: WalletWindow = {}): boolean {
  if (named(w.id) || named(w.name)) return true;
  if ((Array.isArray(w.rdns) ? w.rdns : [w.rdns]).some(named)) return true;
  const p = w.provider as { isPhantom?: boolean } | null | undefined;
  if (p && p.isPhantom === true) return true;
  // Phantom's own EVM provider, or window.ethereum when Phantom has taken it.
  if (p && win.phantom?.ethereum && p === win.phantom.ethereum) return true;
  const eth = win.ethereum as { isPhantom?: boolean } | undefined;
  return Boolean(p && eth && p === eth && eth.isPhantom === true);
}

/** The error code a wallet gave (EIP-1193 / JSON-RPC), however deeply it's wrapped; null without one. */
export function walletErrorCode(err: unknown): number | string | null {
  let e = err as { code?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; i < 6 && e; i++) {
    if (typeof e.code === "number" || typeof e.code === "string") return e.code;
    e = e.cause as typeof e;
  }
  return null;
}

/** The message for a switch that failed: declined by the user (4001), or the wallet couldn't (4902, 4200, -32601 or any other). */
export function switchFailureMessage(err: unknown): string {
  return walletErrorCode(err) === 4001 ? SWITCH_DECLINED_MESSAGE : SWITCH_FAILED_MESSAGE;
}

export type SwitchOutcome = { kind: "switched" } | { kind: "phantom"; message: string } | { kind: "failed"; message: string; code: number | string | null };

/**
 * Switches the connected wallet to Robinhood Chain testnet (adding it when missing), unless it's Phantom. Any failure,
 * or no answer within `timeoutMs`, comes back as a message; the wallet's name and the error code go to the log.
 */
export async function switchToRobinhood(d: {
  wallet: WalletInfo;
  win?: WalletWindow;
  switchChain: () => Promise<unknown>;
  log?: (line: string) => void;
  timeoutMs?: number;
}): Promise<SwitchOutcome> {
  const log = d.log ?? ((l: string) => console.warn(l));
  const name = d.wallet.name ?? d.wallet.id ?? "unknown wallet";
  if (isPhantom(d.wallet, d.win)) {
    log(`[glance] wallet ${name}: Phantom can't add Robinhood Chain testnet; not asking it to switch`);
    return { kind: "phantom", message: PHANTOM_MESSAGE };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      d.switchChain(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("The wallet didn't answer the network switch"), { code: "timeout" })), d.timeoutMs ?? SWITCH_TIMEOUT_MS);
      }),
    ]);
    return { kind: "switched" };
  } catch (err) {
    const code = walletErrorCode(err);
    log(`[glance] wallet ${name} couldn't switch to Robinhood Chain testnet (code ${code ?? "none"})`);
    return { kind: "failed", message: switchFailureMessage(err), code };
  } finally {
    clearTimeout(timer);
  }
}
