# Glance browser extension

Glance puts a small orb on every web page. It underlines companies it can trade (Tesla, Amazon, Palantir, Netflix,
AMD), shows their live price when you hover over one, and buys through your Glance vault. You can talk to it or type.

The extension never holds a private key and never signs anything. It asks the Glance API. The API's agent key can
only trade inside the limits your vault enforces on chain, and when a limit says no, Glance tells you why.

Works in Chrome 116 or newer, Brave and Microsoft Edge (all built on the same engine).

## Install it (no coding needed)

You will load Glance as an "unpacked" extension. This is Chrome's normal way to try an extension that is not in the
Chrome Web Store. It takes about a minute.

1. **Get the extension folder.**
   - If you were given `glance-extension-0.1.0.zip`, double-click it to unzip it. You now have a folder (on a Mac it
     is named `glance-extension-0.1.0`). Leave it somewhere you won't delete it, such as your Documents folder:
     Chrome loads the extension from this folder every time it starts.
   - If you are building from the source code, run `pnpm install` and then `pnpm --filter extension build`. The folder
     is `apps/extension/.output/chrome-mv3`.
2. **Open the extensions page.** In Chrome, type `chrome://extensions` into the address bar and press Enter.
   (Brave: `brave://extensions`. Edge: `edge://extensions`.)
3. **Turn on Developer mode.**
   - Chrome and Brave: the switch is in the top right corner.
   - Edge: the switch is in the left sidebar.
4. **Click "Load unpacked"**, which appeared once Developer mode was on, and choose the folder from step 1: the one
   that directly contains a file named `manifest.json`.
5. **Pin Glance.** Click the puzzle-piece icon next to the address bar, then the pin next to Glance. Clicking the Glance
   icon later opens it in the side panel.

Glance opens its settings page the first time. The extension ID shown there should be
`ldkhnhnmgilpmpdacnfajmilandbalfj`. It is the same on every computer.

Chrome may show a banner about developer-mode extensions when it starts. That is expected for any unpacked extension.
Close the banner.

## Set it up

1. **Start the Glance API** (the extension talks only to it). From the repository root:
   ```sh
   pnpm install
   pnpm --filter api dev        # runs on http://localhost:8790
   ```
2. **Open Glance's settings.** Right-click the Glance icon and choose Options.
3. **API base URL:** leave `http://localhost:8790` unless the API runs elsewhere. For any other address Glance asks
   your permission once.
4. **Vault address:** paste your vault, or click **Use the demo vault** after running the connection test.
5. Click **Save**. The connection test then shows the chain, the agent's ETH balance, and how fresh each price is.

## Use it

- **Find companies.** Read any news article, for example a CNBC or Reuters story about Tesla. Company names get a
  subtle dotted underline. Glance never changes the page's text or layout.
- **Hover a name.** A card shows the company, its ticker, the live price, how old that price is, and whether the
  market is open. Pick $10, $25 or $100, or type an amount.
- **Buy.** Glance first checks your trade against every vault limit on chain, then shows what will happen. Confirm, and
  you get a receipt with a link to the transaction on the Robinhood Chain explorer.
- **When the vault says no**, you get an amber card that explains why and offers the right next step. Examples: "Buy
  $100 instead" when you are over your per-trade limit, when your daily limit frees up, or why Glance won't trade on a
  stale price. Nothing moves when that happens.
- **Talk.** Click the orb, or press and hold **Option + G** (Alt + G on Windows), and say one of these:
  - "buy ten dollars of Tesla"
  - "buy $25 of TSLA"
  - "what's Tesla at"
  - "how much have I spent today"

  Release the keys to send. When Glance quotes a buy, say "yes" or click Confirm. You can type the same things in the
  box instead.
- **Market closed.** When the stock market is shut, an amber badge shows how old the prices are, and that your limits
  are cut to 25%.
- **Floating or docked.** The orb floats on every page and can be dragged anywhere; it remembers where you put it.
  Choose "Dock to the side panel" to move Glance into the browser's side panel instead. While docked, the orb
  disappears from pages so it never covers a site's own buttons.

## Good to know

- **Voice uses your browser's built-in speech recognition.** Chrome and Edge support it. Brave turns it off, so type
  instead there. A page may ask for microphone permission the first time you talk on it. For the side panel, click
  "Allow the microphone for the side panel" in settings once.
- **Keyboard:**
  - Tab to the orb and press Enter to open Glance. Escape closes it.
  - Every company found on the page is listed in the panel. Pick one to open its card, or to scroll to it on the page.
- **Reduced motion:** if your system asks for reduced motion, the orb and cards stop animating.

## For developers

```sh
pnpm --filter extension dev         # opens a browser with Glance loaded and hot reload
pnpm --filter extension build       # production build in .output/chrome-mv3
pnpm --filter extension zip         # .output/glance-extension-<version>.zip, for sharing
pnpm --filter extension test        # unit tests (commands, blocked card, page text, design tokens)
node apps/extension/e2e/smoke.mjs   # loads the build on a real CNBC article (API must be running)
```

How it's built:

- **Stack:** WXT, React 18 and TypeScript; Manifest V3.
- **Colours:** every colour lives in `lib/tokens.ts`, transcribed from `design/Glance Foundations.html`. A test fails
  if a colour appears anywhere else.
- **Isolation:** the in-page UI renders in a shadow root. Underlines use the CSS Custom Highlight API, so the page's
  DOM is never modified.
- **The orb:** it follows the foundations spec. Its dotted "listening" and "thinking" motion comes from the MIT-licensed
  [thinking-orbs](https://github.com/Jakubantalik/thinking-orbs) library.
- **API access:** only the background service worker calls the API.
