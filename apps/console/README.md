# Glance console

Where a vault owner sees and controls their vault, and where anyone can check that the guards are real. It reads from
the Glance API and changes things only through the owner's own wallet. It never touches the agent key and never signs
anything itself.

| Page | What it shows |
| --- | --- |
| **Dashboard** | USDG, positions (quantity and value at the vault's oracle price), total. The three caps (per trade, 24h buys, 24h sells) with used against remaining and when the window frees up, for both market open and market closed, with the set in force marked. The agent's address, time to expiry, paused or not, and a plain statement of what it can and can't do. |
| **Limits** | Edit the per-trade cap, the daily buy and sell caps, max slippage and the market-closed share. Pause switch. Renew the agent, or revoke it (with a confirmation). Every change is a transaction from the owner's wallet, shown checking, in the wallet, pending with its hash, then confirmed or failed with the reason and an explorer link. |
| **Activity** | Every trade and owner change, newest first, each with its transaction, and the refusals next to them in the API's own sentences. |
| **Prices** | The five stocks: price, age in hours, market state, and whether each feed is real or a mirrored stand-in. When the keeper last wrote. |
| **Get started** | Connect, add the network, get test ETH and USDG, create and fund a vault, install the extension. Each step's done state comes from the chain. |

## Run it locally

```sh
pnpm install
pnpm --filter api dev        # the Glance API, http://localhost:8790
pnpm --filter console dev    # the console, http://localhost:3000
```

Every variable is optional locally. The defaults point at the API on `localhost:8790` and the public testnet RPC. To
change them, copy `.env.example` to `.env.local`.

## Environment

| Variable | Default | What it's for |
| --- | --- | --- |
| `NEXT_PUBLIC_GLANCE_API_URL` | `http://localhost:8790` | The Glance API the console reads from. Deployed, it must be a public HTTPS URL, and the API's `CORS_ORIGINS` must include the console's origin. |
| `NEXT_PUBLIC_RPC_URL` | `https://rpc.testnet.chain.robinhood.com` | Robinhood Chain testnet RPC, tried first (for example your QuickNode endpoint). The console uses it for its own reads (owner checks, your vault, balances) and to wait for your transactions. |
| `NEXT_PUBLIC_RPC_FALLBACK_URLS` | the public RPC | Comma-separated endpoints tried in order when the first fails, as the API's `RPC_FALLBACK_URLS` does. |
| `NEXT_PUBLIC_EXPLORER_URL` | `https://explorer.testnet.chain.robinhood.com` | Transaction and address links. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | none | Optional. Without it, browser wallets work (MetaMask, Rabby, Brave Wallet, Coinbase Wallet, any injected wallet). With it, phone wallets can also connect by QR code. |

`NEXT_PUBLIC_*` values are inlined at build time and visible to anyone, so none of them may be a secret. A
QuickNode URL with a token in it is visible too. Give the console its own endpoint, and restrict it to the console's
domain in QuickNode.

## Deploy to Vercel

Import the repository as a project with:

| Setting | Value |
| --- | --- |
| Root Directory | `apps/console` |
| Framework Preset | Next.js |
| Install Command | `pnpm install --frozen-lockfile` (the default Vercel picks for this pnpm workspace) |
| Build Command | `next build` (the default) |
| Output Directory | the default (`.next`) |
| Node.js Version | 22.x or later |
| Include files outside the root directory | On (the default). The console reads `deployments/46630.json` and `packages/*`. |

Set the variables above under Settings → Environment Variables, at least `NEXT_PUBLIC_GLANCE_API_URL`. Then, on the
API, add the console's URL to `CORS_ORIGINS` (for example `https://glance-console.vercel.app`) and restart it.

## How it's built

- **Next.js App Router** with wagmi, viem and RainbowKit. It has one chain, Robinhood Chain testnet (46630), and
  reads use the same primary-plus-fallback RPC transport as the API (`@glance/core/rpc`). Every Glance address comes
  from `deployments/46630.json`. The one other address, the canonical Multicall3, is standard infrastructure.
- **Design.** `@glance/design` (`packages/design`) is the extension's token module, now shared: the same colors,
  type, spacing and motion, and the same bundled Geist faces. Dark is the default and light is supported. No color is
  written anywhere else; `test/tokens.test.ts` fails if one is.
- **Guard sentences.** `@glance/core` (`packages/core`) holds the ABIs, `explainRevert`, money formatting and the
  window maths, shared with the API. When the vault refuses an owner's own change, the console shows the same
  sentence the API and the extension would.
- **Money.** Amounts are bigints in each token's real decimals (6 for USDG, 18 for stocks) all the way to the screen.
- **Refusals.** A vault emits no event for a trade it refuses, so the activity page has two sources, and says which
  each refusal comes from:
  - *Checked against the vault, never sent.* The API simulates every trade as the agent against the live vault
    before signing. When a guard would stop it, nothing is sent, and the API records the refusal (see
    `REFUSAL_LOG_FILE` in the API).
  - *Reverted on chain.* Transactions that reached the vault and failed, read from the explorer, with a transaction
    link and the reason decoded from the vault's own error.
- **States.** Every state has a design: loading, empty, no wallet, wrong network (one click switches, and adds the
  network if it's missing), not the owner (controls off, and the page says whose vault it is), API unreachable,
  testnet not responding (the API's `RPC_UNAVAILABLE` wording, and reads retry and recover on their own), transaction
  pending, and transaction failed.
- **Get started** runs exactly what `make create-vault` does, one wallet confirmation at a time, re-reading the
  chain before each step:
  1. create the vault;
  2. approve the five stocks with their feeds;
  3. set freshness to 20 hours open and 96 hours closed;
  4. approve the stock desk;
  5. authorise the agent for 29 days;
  6. deposit.

  The new vault can trade as soon as it's funded. The extension step is the only one not read from the chain: the
  extension marks the console page when it's installed.

## Tests

```sh
pnpm --filter console test        # formatting, cap maths, limits rules, guard wording, the setup plan, the API client,
                                  # and the not-owner and wrong-network states rendered in jsdom
pnpm --filter console lint        # oxlint (React, hooks, Next.js, a11y, TypeScript rules); typescript-eslint doesn't
                                  # support TypeScript 7 yet, which the workspace uses
pnpm --filter console typecheck
pnpm --filter console build
```

No test sends a transaction.
