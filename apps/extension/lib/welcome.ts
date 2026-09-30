/**
 * The Welcome page's words (entrypoints/welcome): the structure, order, headings, buttons and wording of GLANCE by
 * Heylana's first-run screens, line for line, with only the facts changed for this product (Robinhood Chain testnet,
 * Paxos USDG, your own vault and its leash, the stocks in the catalog, ⌥G / ⌥V / Escape). The wallet steps themselves
 * happen on the console's Get started page: nothing here moves money or sets a limit.
 */
import { storage } from "wxt/utils/storage";

/** The leash a new vault starts with (the console's defaults, changed on its Limits page). */
export const LEASH = { perTrade: 100, perDay: 500, closedPct: 25 } as const;

/** Where "I don't have one yet" goes: a browser wallet to install. */
export const WALLET_DOWNLOAD_URL = "https://metamask.io/download/";

/** The stock list, as said in a sentence: "TSLA, AMZN and PLTR". */
export function stockList(symbols: readonly string[]): string {
  if (symbols.length === 0) return "the stocks in my list";
  return symbols.length === 1 ? symbols[0]! : `${symbols.slice(0, -1).join(", ")} and ${symbols.at(-1)}`;
}

export const WELCOME = {
  title: "Glance",
  signIn: {
    heading: "Hey. I'm Glance.",
    installed: "I'm installed. ",
    intro: "I live on every page you read and buy stocks in one tap. Connect a wallet to start. It costs nothing and moves nothing.",
    step1: "Step 1 of 2",
    pick: "Pick a wallet.",
    wallet: "MetaMask, Rabby or Brave Wallet",
    noWallet: "I don't have one yet",
    step2: "Step 2 of 2",
    tabOpen: "Glance tab open",
    waiting: "waiting",
    approve: "Connect your wallet in the Glance tab.",
    updates: "This page updates by itself once you have.",
  },
  fund: {
    eyebrow: "Setup 1 of 2",
    heading: "Fund the vault.",
    body: "This is the only pot I can spend from. Nothing else in your wallet is reachable.",
    tiles: [25, 50, 100] as const,
    button: (fund: number) => `Fund $${fund}`,
    note: "Test money on Robinhood Chain testnet, in Paxos USDG. No real funds move.",
  },
  leash: {
    eyebrow: "Setup 2 of 2",
    heading: "Set my leash.",
    body: "The most I can spend in any 24 hours. Past it, I stop and say why.",
    tiles: [`$${LEASH.perTrade} / trade`, `$${LEASH.perDay} / day`, `${LEASH.closedPct}% while closed`] as const,
    button: "Let's go",
    note: "Approvals in your wallet, in the Glance tab. Change the leash any time on the console's Limits page.",
  },
  almost: {
    eyebrow: "Almost there",
    heading: "Approve it in the Glance tab.",
    body: (fund: number, symbols: readonly string[]) =>
      `A few approvals create your vault with $${fund} of test USDG in it and let me trade up to $${LEASH.perTrade} at a time and $${LEASH.perDay} a day, ${LEASH.closedPct}% of that while the market is closed. I can only trade ${stockList(symbols)} in that vault and can never send money anywhere else.`,
    found: "Vault found. One moment…",
    waiting: "Waiting for your approval in your wallet…",
    reopen: "Reopen the Glance tab",
    change: "Change the amounts",
  },
  tryIt: {
    eyebrow: "All set",
    celebrated: "That's a glance.",
    heading: "Click a company on the page.",
    done: "You're all set.",
    /** Split around the two keys, so they can be shown as keys. */
    body: (glanceKey: string, voiceKey: string, example: string) =>
      [
        "Open any article about a company and press ",
        glanceKey,
        ", or tap the orb in the corner of the page. I'll offer to buy it. You can also hold ",
        voiceKey,
        ` and say “buy ten dollars of ${example}”. Escape stops me.`,
      ] as const,
    button: "Go to my portfolio",
  },
} as const;

/** Every line of the Welcome page as shown (for the no-dashes and no-foreign-names checks). */
export function welcomeLines(symbols: readonly string[] = ["TSLA"]): string[] {
  const w = WELCOME;
  return [
    w.title,
    ...Object.values(w.signIn),
    w.fund.eyebrow,
    w.fund.heading,
    w.fund.body,
    w.fund.button(50),
    w.fund.note,
    ...w.leash.tiles,
    w.leash.eyebrow,
    w.leash.heading,
    w.leash.body,
    w.leash.button,
    w.leash.note,
    w.almost.eyebrow,
    w.almost.heading,
    w.almost.body(50, symbols),
    w.almost.found,
    w.almost.waiting,
    w.almost.reopen,
    w.almost.change,
    w.tryIt.eyebrow,
    w.tryIt.celebrated,
    w.tryIt.heading,
    w.tryIt.done,
    w.tryIt.body("⌥G", "⌥V", "Tesla").join(""),
    w.tryIt.button,
  ];
}

/** When the first question was answered (the Welcome page celebrates it: "That's a glance."). */
export const firstAnswerAt = storage.defineItem<number | null>("local:firstAnswerAt", { fallback: null });

/** "That's a glance." shows when the first answer came in after (or within a minute before) the page was opened. */
export function celebrate(firstAt: number | null, openedAt: number): boolean {
  return firstAt !== null && firstAt >= openedAt - 60_000;
}

/** Which stage to show, from what the console reported and whether Glance is set up (display only). */
export function welcomeStage(p: { setupComplete: boolean; wallet: boolean }): "signin" | "account" | "tryit" {
  if (p.setupComplete) return "tryit";
  return p.wallet ? "account" : "signin";
}
