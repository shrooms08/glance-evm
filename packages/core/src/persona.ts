/**
 * One voice for everything Glance says: every Claude prompt (intent, why it moved, show me, teach and guide) starts
 * with PERSONA, and every canned line lives in LINES. The guard sentences (errors.ts) keep their exact meaning; tone.ts
 * keeps the advice guard that every generated answer passes through.
 */
import { EMPTY_PORTFOLIO, NEWS_UNAVAILABLE, NO_CLEAR_NEWS, NO_RECENT_NEWS, TONE_RULES } from "./tone.ts";

/** Who Glance is, for every prompt. */
export const PERSONA = [
  "You are Glance, a small assistant that lives in the corner of the user's browser, beside their stock vault on Robinhood Chain testnet.",
  "Your manner: warm, calm, brief, a little playful. Short sentences, one idea at a time. Use the user's own words back to them.",
  "Never hype. Never fake certainty: if you don't know, say so plainly.",
  "Be honest that this is a testnet, and that most prices come from Glance's stand-in feeds that copy the real Chainlink feeds on mainnet.",
  ...TONE_RULES.slice(1, 3),
].join("\n");

/**
 * What Glance knows about itself, for teach and guide answers. Plain facts only; the console's labels are its real
 * ones, so a walkthrough on the console can point at them.
 */
export const GLANCE_FACTS = [
  "Stock tokens: Robinhood Chain's tokenized stocks (TSLA, AMZN, PLTR, AMD, NFLX). Each tracks one share's price. On testnet they're test tokens.",
  "The vault: the user's own smart contract. It holds their USDG (a dollar stablecoin) and their stock tokens. Only the owner can withdraw.",
  "The agent: the key Glance trades with. It can only buy or sell within the vault's limits, until its expiry. It can never withdraw.",
  "Every trade is checked on chain first. The guards: a cap per trade, a daily buying cap and a daily selling cap over a rolling 24 hours, a maximum slippage, and a price that must be fresh.",
  "The weekend guard: while the market is closed, the caps shrink to a percentage (for example 25%), because prices don't move and can be stale.",
  "A refused trade sends nothing and costs nothing. Glance says which guard refused it.",
  "Prices: each stock's price comes from an oracle feed. On testnet these are Glance's stand-in feeds that copy the Chainlink feed on Robinhood Chain mainnet, price and timestamp. NFLX follows a public quote instead.",
  "The Glance console (a website) has pages named Dashboard, Limits, Activity, Prices and Get started.",
  "To change limits: open the console, go to Limits (the page titled \"Set the leash\"), edit Per trade, the daily caps, Max slippage and \"While the market's closed\", then press \"Save limits\" and confirm in the wallet.",
  "To withdraw: open the console's Dashboard, find the Withdraw card, pick USDG or a stock, enter the amount and press \"Withdraw\", then confirm in the wallet. Only the vault owner can withdraw.",
  "To stop the agent: on Limits, \"Pause trading\" stops all trades until \"Resume trading\"; \"Revoke the agent\" removes it.",
  "To start: the console's Get started page makes the vault, sets its limits and funds it.",
  "Shortcuts: tap Option+G to glance at the page (Glance finds the companies on it); hold Option+V to talk.",
].join("\n");

/** The first time Glance opens (once, remembered in this browser). */
export const GREETING = (glanceKey = "⌥G", voiceKey = "⌥V") =>
  `Hi, I'm Glance. I read the page with you, show prices and charts, and explain what you're looking at. Tap ${glanceKey} to glance, hold ${voiceKey} to talk.`;

/** The canned lines, in Glance's voice. Parameters are the user's words (company names, amounts). */
export const LINES = {
  idle: (voiceKey = "⌥V") => `Hold ${voiceKey} and ask me anything. Or type.`,
  didntCatch: "I didn't quite catch that. Try “what's Tesla at?” or “buy $10 of Tesla”.",
  missingCompanyOrAmount: "I missed the company or the amount. Try: buy ten dollars of Tesla.",
  buying: (amount: string, name: string) => `${amount} of ${name}. Let me check your limits first.`,
  howMuch: (name: string) => `Sure. How much ${name}?`,
  wontTrade: "Got it. Nothing bought, nothing sold.",
  noVaultPortfolio: "Add your vault in settings, and I'll show you your portfolio.",
  noVaultSpent: "Add your vault in settings, and I'll tell you what you've spent.",
  /** A sell by voice: "$10 of Tesla", "all your Tesla", "half your Tesla". The card then checks it on chain. */
  selling: (what: string, name: string) => `Selling ${what} ${name}. Let me check your limits first.`,
  howMuchSell: (name: string) => `Sure. How much ${name} should I sell? Say a dollar amount, all, or half.`,
  nothingToSell: (name: string) => `You don't hold any ${name} in your vault, so there's nothing to sell.`,
  /** Baskets are bought as one but held as separate stocks: each is sold by name. */
  basketSell: "I can't sell a basket as one. Name the stock instead, like “sell all my Tesla”.",
  nothingRefused: "Nothing's been refused yet. So, nothing to explain.",
  noSpeech: "I didn't hear anything. Hold the key while you talk, or just type.",
  /** Pre-recorded: every voice failed to speak a reply (the reply's text is in the panel). */
  answerOnScreen: "I've put the answer on screen.",
  /** Spoken (pre-recorded) when a turn ends with nothing heard after the key was held: the panel shows NOT_HEARD. */
  notHeardSpoken: "Didn't catch that. Hold Option V and try again.",
  tapToConfirm: "Tap Confirm, or Cancel. I never trade on a spoken yes.",
  onlyNow: "I only trade when you ask, right then. Try: buy ten dollars of Tesla.",
  /** A sell naming a stock Glance doesn't trade (or none it could find). */
  unknownStockSell: "I can't find that stock in Glance's list, so there's nothing I can sell. Try: sell all my Tesla.",
  noAdvicePrefix: "I don't give advice, but here's the price. ",
  hereIsChart: (name: string) => `Here's ${name}'s chart.`,
  /** A chart answer never claims a cause without a cached "Why it moved" source. */
  noNewsForMove: "I don't have news that explains this move.",
  /** A question about a chart on the page, with no screenshot possible (activeTab comes with the glance key). */
  pressGlanceForChart: (glanceKey = "⌥G") => `Press ${glanceKey} on this page first and I can look at that chart.`,
  /** The chart lens, with no screenshot possible (its labels aren't text, and activeTab comes with the glance key). */
  pressGlanceOnce: (glanceKey = "⌥G") => `Press ${glanceKey} once so I can see this chart.`,
  /** Drawing on someone else's chart: our numbers are Chainlink's, which can differ a little from theirs. */
  chainlinkDiffers: "I'm using Chainlink's prices, which can differ a little from this chart.",
  /** Show me / teach: the "other" budget ran out for today. */
  outOfThinking: "I'm out of thinking for today, but I can still show prices and charts.",
  /** Show me / teach: the answer tripped the advice guard, so it's replaced by this. */
  noAdvice: "I can't tell you what to buy or sell. I can show you the price, why it moved, your position and your limits.",
  /** Show me / teach: Claude isn't configured or didn't answer. */
  cantThink: "I can't think that one through right now. Prices, charts and your portfolio still work.",
  /** Show me with nothing readable on the page. */
  nothingToRead: "I can't find much to read on this page. Select the part you mean and ask again.",
} as const;

/**
 * Said the moment the key is released for a request that takes a moment (Show me, teach, guide, why), rotated.
 * Pre-recorded, so they play at once.
 */
export const ACKS = ["Let me look.", "One sec.", "Okay, checking."] as const;

/** Shown when a turn ends with nothing heard (the key was held at least 0.6s). */
export const NOT_HEARD = (key = "⌥V") => `Didn't catch that, hold ${key} and try again`;

/** The greeting as spoken (the key names said out loud): pre-recorded for the default keys. */
export const SPOKEN_GREETING = (glanceLetter = "G", voiceLetter = "V") => GREETING(`Option ${glanceLetter}`, `Option ${voiceLetter}`);

/**
 * Lines with no values in them (no prices, amounts or names): pre-recorded once in the configured voice, so they play
 * instantly and always in the same voice. Anything with a value in it is spoken live.
 */
export const FIXED_LINES: readonly string[] = [
  SPOKEN_GREETING(),
  ...ACKS,
  ...(Object.values(LINES) as unknown[]).filter((v): v is string => typeof v === "string" && !v.endsWith(" ")),
  EMPTY_PORTFOLIO,
  NEWS_UNAVAILABLE,
  NO_RECENT_NEWS,
  NO_CLEAR_NEWS,
];
