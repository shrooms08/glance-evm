/**
 * "Set me up": Get started runs itself. Each step starts on its own the moment the one before is done, so the user only
 * answers wallet prompts:
 *   connect (the one click) -> network (a wallet prompt) -> gas (the starter fund, automatic) -> USDG (the starter fund,
 *   automatic) -> create the vault with its deposit (approve, create) -> link Glance (sign), chained.
 * Every automatic action is tried once per visit; if a prompt is refused or a step fails, the page stops there and
 * shows that step's one button.
 */
export type AutoAction = "switch-network" | "get-gas" | "get-usdg" | "create" | "link";

export interface AutoState {
  connected: boolean;
  onChain: boolean;
  /** The wallet's ETH, in wei (null while unknown). */
  eth: bigint | null;
  /** The wallet's USDG, in its smallest unit (null while unknown). */
  walletUsdg: bigint | null;
  usdgDecimals: number;
  /** The first deposit, in USDG's smallest unit. */
  deposit: bigint;
  /** The vault exists, is configured and holds USDG. */
  vaultReady: boolean;
  /** Glance is in this browser, and linked to the vault. */
  glancePresent: boolean;
  linked: boolean;
  /** The starter fund can send each (on, and stocked). */
  faucet: { gas: boolean; usdg: boolean };
  /** Something is already running (a wallet prompt, a transaction, a faucet send). */
  busy: boolean;
  /** What was already tried this visit. */
  tried: ReadonlySet<AutoAction>;
}

/** Under this, a wallet gets the starter fund's gas (0.0002 ETH). */
export const GAS_ENOUGH = 200_000_000_000_000n;
/** Under this many whole USDG, a wallet gets the starter fund's USDG. */
export const STARTER_BELOW = 5n;

/** The next thing to start by itself, or null (waiting for funds to arrive, for the user, or all done). */
export function nextAutoAction(s: AutoState): AutoAction | null {
  if (!s.connected || s.busy) return null;
  const once = (a: AutoAction) => (s.tried.has(a) ? null : a);
  if (!s.onChain) return once("switch-network");
  if (s.eth === null || s.walletUsdg === null) return null; // still reading the wallet
  if (!s.vaultReady) {
    // Gas first: nothing else can be sent without it.
    if (s.eth === 0n || (s.eth < GAS_ENOUGH && s.faucet.gas && !s.tried.has("get-gas"))) return s.faucet.gas ? once("get-gas") : null;
    // Then the deposit's USDG.
    if (s.walletUsdg < s.deposit) {
      const small = s.walletUsdg < STARTER_BELOW * 10n ** BigInt(s.usdgDecimals);
      return s.faucet.usdg && small ? once("get-usdg") : null;
    }
    return once("create"); // creating goes straight on to linking Glance (Get started chains it)
  }
  if (s.glancePresent && !s.linked) return once("link");
  return null;
}

/**
 * The plan shown up front: "5 wallet prompts: connect, network, approve, create, sign", without the ones already done
 * (no approve when the allowance already covers the deposit, no sign without Glance in this browser).
 */
export function promptPlan(p: { connected: boolean; onChain: boolean; vaultReady: boolean; approveNeeded: boolean; glancePresent: boolean; linked: boolean }): string {
  const names: string[] = [];
  if (!p.connected) names.push("connect");
  if (!p.onChain) names.push("network");
  if (!p.vaultReady) {
    if (p.approveNeeded) names.push("approve");
    names.push("create");
  }
  if (!p.linked && (p.glancePresent || !p.vaultReady)) names.push("sign");
  if (names.length === 0) return "Nothing left to sign: you're set up.";
  return `${names.length} wallet prompt${names.length === 1 ? "" : "s"}: ${names.join(", ")}`;
}
