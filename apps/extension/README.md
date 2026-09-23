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
6. **Voice (optional):** in the Voice section, click **Enable voice**. Chrome asks "Glance wants to use your
   microphone"; click **Allow**. You only do this once, and it covers every website. The diagnostics below the button
   show your browser and version, and whether each part of voice is available.

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
- **Two keys, two verbs** (Alt instead of Option on Windows; both can be changed in settings):
  - **Option + G, tap: glance.** Glance scans the page, opens its panel and says what it found, for example "Reading
    cnbc.com, 1 name found, Tesla 16×". It never listens.
  - **Option + V, hold: talk.** Glance listens while you hold the keys, thinks when you let go, and speaks the reply.
    Option + V types a symbol in some Mac apps; if it clashes with one you use, pick another letter in settings.
- **Talk.** Hold **Option + V** (or use the mic button in the panel) and say one of these:
  - "buy ten dollars of Tesla"
  - "buy $25 of TSLA"
  - "what's Tesla at"
  - "how much have I spent today"

  Release the keys to send. When Glance quotes a buy, say "yes" or click Confirm. You can type the same things in the
  box instead.
- **Market closed.** When the stock market is shut, an amber badge shows how old the prices are, and that your limits
  are cut to 25%.
- **Floating or docked.** The orb floats on every page and can be dragged anywhere; it remembers where you put it.
  Its panel melts out of the orb when it opens and flows back into it when it closes. **Click the orb** to dock Glance
  in the browser's side panel instead (or choose "Dock to the side panel" in the panel). While docked, the orb
  disappears from pages so it never covers a site's own buttons, and both keys still work.

## Good to know

- **Voice needs Google Chrome.** Glance uses the browser's built-in speech recognition, which sends audio to Google's
  speech service. Only Google Chrome ships with it. Arc, Brave, open-source Chromium and other non-Google Chromium
  builds don't, so voice can't work there; Glance says so plainly, and you can always type.
  Websites never see your microphone: Glance listens in its own extension context, under the permission you gave it
  once in settings, so a site that blocks microphones doesn't stop it.
- **After you reload or update Glance** (for example from `chrome://extensions`), refresh the tabs that were already
  open. Chrome disconnects extensions from open pages when they reload; Glance notices, steps aside quietly, and shows
  "Glance was updated. Refresh this page to use it." with a Refresh button where the orb was.
- **Keyboard:**
  - Tab to the orb and press Enter to glance (open the panel). Escape closes it.
  - Every company found on the page is listed in the panel. Pick one to open its card, or to scroll to it on the page.
- **Reduced motion:** if your system asks for reduced motion, the orb and cards stop animating, and the panel opens
  with a short fade instead of the liquid melt.

## For developers

```sh
pnpm --filter extension dev         # opens a browser with Glance loaded and hot reload
pnpm --filter extension build       # production build in .output/chrome-mv3
pnpm --filter extension zip         # .output/glance-extension-<version>.zip, for sharing
pnpm --filter extension test        # unit tests (commands, blocked card, page text, tokens, voice, hotkeys, goo, reloads)
node apps/extension/e2e/smoke.mjs   # loads the build on a real CNBC article (API must be running)
node apps/extension/e2e/voice.mjs   # voice plumbing in Chromium, on a page that blocks the microphone
node apps/extension/e2e/interaction.mjs  # hotkeys, the gooey panel, orb-click docking, and an extension reload, on CNBC
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
- **Voice:** speech recognition never runs in the web page. From the floating orb, the background opens an offscreen
  document (`entrypoints/offscreen`, reason `USER_MEDIA`) that listens, and relays each session's events (started,
  interim text, final text, error, end) back to the tab. In the side panel, recognition runs in the panel itself.
  Either way the microphone permission belongs to `chrome-extension://ldkhnhnmgilpmpdacnfajmilandbalfj`. Every
  failure maps to one sentence in `lib/voiceReasons.ts`. In development builds the console logs
  `[glance] voice: running in <browser> <version>`.
- **Gooey open and close:** `components/GooPanel.tsx`, built on [liquid-gooey](https://libraries.dev/gooey) (MIT).
  Only two empty shapes (a disc under the orb and a box that grows to the panel's footprint) are filtered; the panel's
  text, prices and buttons sit on top, unfiltered, and fade in once the liquid has its shape. The SVG filter renders
  inside our shadow root, and the liquid layer is removed as soon as the motion ends. Timings are the design tokens
  `motion.panel` (180ms) and `motion.quick` (120ms). If a page drops frames on two opens in a row, Glance lowers the
  filter quality (smaller blur, no shadow) rather than the animation.
- **Surviving reloads:** `lib/lifecycle.ts` and `lib/pageLifecycle.ts`. Every extension call from the page goes through
  `send()` or `safely()`; a port to the background and a `runtime.id` check notice a reload within moments. The page
  UI then shuts down once (UI removed, listeners gone, underlines cleared) and shows the refresh notice. The expected
  "Extension context invalidated" error is never logged.
- **Springs:** `lib/spring.ts`, tuned entirely from `spring` and `breathe` in `lib/tokens.ts`. They carry velocity, so
  they react to distance and speed. The panel's open overshoots once (only while no text is showing); the orb trails a
  drag, jiggles once on release, wobbles as it absorbs the closing panel, shakes once when a trade is refused, and
  breathes very slowly when idle. Nothing springs on text, the confirm card or hover cards, and nothing moves under
  reduced motion. `lib/motionBudget.ts` drops the idle breathing first on pages that can't hold frame rate.
- **Orb states:** idle shows the eye; listening, thinking and speaking each have their own dotted motion
  (`ORB_MOTION` in `components/Orb.tsx`). Speaking follows the speech itself: it starts on the utterance's `start`
  event and stops on its `end`, not on a timer.

## Voice: manual test checklist

Voice can't be fully tested headlessly (no real microphone or Google speech service), so run this by hand in
**Google Chrome** after any change to voice. Reload the extension in `chrome://extensions` first.

**Settings**

- [ ] Open Glance's settings. The Voice section's diagnostics show "Google Chrome" and a version, speech recognition
      "available", speech output "available", a voice count above 0, a microphone "found", and permission "not asked
      yet" (on a fresh install).
- [ ] Click **Enable voice**. Chrome shows "Glance wants to use your microphone" (the prompt names the extension, not
      a website). Click **Allow**. The button changes to "Voice enabled" and the permission reads "granted to Glance".
- [ ] Click **Test listening**, say "what's Tesla at", click **Stop**. The small orb shows the listening motion, then
      the line reads: Heard “what's Tesla at”. Voice works.
- [ ] Click **Test speaking**. The orb's dots start moving (lime, a flowing band) the moment you hear the voice, and
      stop exactly when it finishes.

**Floating orb**

- [ ] On a news article (for example a CNBC Tesla story), tap **Option + G**. The panel melts out of the orb and says
      "Reading cnbc.com, 1 name found, Tesla 16×" (or similar). The orb never goes lime: tapping G never listens.
- [ ] Press and hold **Option + V**. The orb turns lime with a
      dark rolling waveform and a pulse ring: listening. Your words appear in the panel as you speak.
- [ ] Say "what's Tesla at" and release. The orb shows a lime arc orbiting lime dots (thinking) while the price loads,
      then a flowing lime band (speaking) only while the answer is spoken aloud, then the eye (idle).
- [ ] Click the mic button next to the text box, say "buy ten dollars of Tesla", click it again. The Tesla card opens
      and quotes $10; the orb speaks the review line. Say or click "Confirm" only if you mean it (it trades on testnet).
- [ ] Try a site that blocks the microphone (many news sites do). Voice still works.
- [ ] Type "what's Tesla at" in the box and press Enter. It works exactly the same with voice disabled or broken.

**Side panel**

- [ ] Click the orb (or the Glance toolbar icon) to dock it. Hold **Option + V** with the panel focused, and use the mic button:
      same states and results as the floating orb.
- [ ] With the panel docked, click into the web page and hold **Option + V**. The panel's orb shows listening and
      runs what you said.

**Failure messages** (each should show one accurate sentence in the orb panel, and typing still works)

- [ ] Block the microphone for Glance (click the extension's site settings, set Microphone to Block), then talk: "The
      microphone is blocked for Glance…"
- [ ] Reset the permission to "Ask", then talk from a page: "I need microphone access. Click “Enable voice” in
      Glance's settings, then try again."
- [ ] In Brave (optional): "Brave turns off speech recognition. Type instead, or use Google Chrome for voice."
- [ ] Turn off Wi-Fi and talk in Chrome: "Chrome couldn't reach its speech service. Check your connection, or type
      instead."
- [ ] Hold the key and say nothing: "I didn't hear anything."
