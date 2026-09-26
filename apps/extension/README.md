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
   - If you were given `glance-extension-0.1.1.zip`, double-click it to unzip it. You now have a folder (on a Mac it
     is named `glance-extension-0.1.1`). Leave it somewhere you won't delete it, such as your Documents folder:
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
`gmcdcaoneeohbacbnafjdnkkoojgnogl`. It is the same on every computer.

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
4. **Your vault:** Glance needs your own vault, and shows only its setup card until it has one. Click **Set me up** in
   the panel: the console's Get started connects your wallet, funds it, creates the vault and links Glance to it. Nothing
   to paste (a developer can still type a vault under Settings > Advanced).
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
- **Talk.** Hold **Option + V** (or use the mic button in the panel) and say one of these. The orb goes lime while
  you hold, thinks when you let go, and moves while it answers:
  - "buy ten dollars of Tesla"
  - "buy $25 of TSLA"
  - "what's Tesla at"
  - "how much have I spent today"

  Release the keys to send. A spoken buy opens the confirm card: tap Confirm to buy (saying "yes" never confirms a
  trade). You can type the same things in the box instead.
- **Market closed.** When the stock market is shut, an amber badge shows how old the prices are, and that your limits
  are cut to 25%.
- **Floating or docked.** The orb floats on every page and can be dragged anywhere; it remembers where you put it.
  Its panel melts out of the orb when it opens and flows back into it when it closes. **Click the orb** to dock Glance
  in the browser's side panel instead (or choose "Dock to the side panel" in the panel): the orb pours off toward the
  window's edge and the side panel opens as it leaves. Close the side panel and a droplet flows back in from that
  edge and becomes the orb again. While docked, the orb disappears from pages so it never covers a site's own
  buttons, and both keys still work.

## Good to know

- **Voice works in any Chromium browser** (Chrome, Brave, Arc, Edge), because transcription is server-side: Glance
  records your voice in its own extension context (never in the web page), the Glance API transcribes it (Deepgram),
  works out what you meant (Claude), and answers in a calm voice (Deepgram Aura). The API needs `DEEPGRAM_API_KEY` in
  `apps/api/.env` (one key for listening and speaking). If it can't be reached, Glance falls back to the browser's own speech
  recognition (which Brave and Arc lack) and says so in the panel. You can always type.
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
node apps/extension/e2e/voice-server.mjs brave http://localhost:8797   # server voice end to end in Brave, with latency
node apps/extension/e2e/interaction.mjs  # hotkeys, the gooey panel, orb-click docking, and an extension reload, on CNBC
```

**The console's "Install the Glance extension" step.** A tiny content script (`entrypoints/console-marker.content.ts`)
sets `<html data-glance-extension="installed">` on the Glance console, and nowhere else. It runs only on the origins in
`WXT_CONSOLE_ORIGINS`, read at build time: a comma-separated list, default `http://localhost:3000`. Each origin becomes
the match pattern `<origin>/*`, and anything that isn't a plain origin fails the build. For a deployed console:

```sh
WXT_CONSOLE_ORIGINS=http://localhost:3000,https://your-console.vercel.app pnpm --filter extension build
```

Content script matches grant no host permissions, so this doesn't widen what the extension can access. After any
rebuild, click Reload on the browser's extensions page: an unpacked extension keeps running its old copy until then.

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
  Either way the microphone permission belongs to `chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl`. Every
  failure maps to one sentence in `lib/voiceReasons.ts`. In development builds the console logs
  `[glance] voice: running in <browser> <version>`.
- **Liquid motion:** `components/GooPanel.tsx` and `components/DockTransition.tsx`, driven by
  [liquid-gooey](https://libraries.dev/gooey) (MIT) the way it is meant to be used: the orb, a droplet and the panel's
  liquid are `<Liquid.Item>`s in one `<Liquid>` container, moved by the library's own transition (`x`, `y`, `scale`)
  with an overshoot curve and a stagger, so the goo filter merges them as they move and the wobble comes from the
  curve. Every value is in `liquid` in `lib/tokens.ts`. The panel's text, prices and buttons are never inside an item
  or the filtered layer: they fade in only once every item has reached its pose (read back from the library's
  transforms, not timed). The filter renders inside our shadow root and is removed at rest. On slow pages the blur and
  shadow drop; the timing never changes.
- **Docking, in three beats:** (1) an open panel drains back into the orb; (2) the orb and three trailing droplets pour
  off toward the window's right edge, one stagger apart, as one stretching mass; (3) the side panel is requested
  `liquid.panelLeadMs` before the last liquid leaves, so it appears as it goes. Undocking reverses it: the side panel
  closes, the liquid flows back in from the edge, the orb reforms at its saved position, and only then can it open
  again. Chrome opens its side panel on the right by default and a page can't ask which side it is on, so the liquid
  uses the right edge. If Chrome refuses to open the panel, the orb flows straight back.
- **Surviving reloads:** `lib/lifecycle.ts` and `lib/pageLifecycle.ts`. Every extension call from the page goes through
  `send()` or `safely()`; a port to the background and a `runtime.id` check notice a reload within moments. The page
  UI then shuts down once (UI removed, listeners gone, underlines cleared) and shows the refresh notice. The expected
  "Extension context invalidated" error is never logged.
- **Springs (the orb's small motions):** `lib/spring.ts`, tuned from `spring` and `breathe` in `lib/tokens.ts`. The
  orb trails a drag, jiggles once on release, shakes once when a trade is refused, and breathes very slowly when idle. Nothing springs on text, the confirm card or hover cards, and nothing moves under
  reduced motion. `lib/motionBudget.ts` drops the idle breathing first on pages that can't hold frame rate.
- **Orb states:** idle shows the eye; listening, thinking and speaking each have their own dotted motion
  (`ORB_MOTION` in `components/Orb.tsx`). Speaking follows the speech itself: it starts on the utterance's `start`
  event and stops on its `end`, not on a timer.

## Voice: manual test checklist

Run this by hand after any change to voice, in **Brave** (or any Chromium browser): transcription is server-side, so
Brave's missing speech recognition doesn't matter. Start the API with a real `DEEPGRAM_API_KEY` (its startup log names
the active providers), and reload the extension first.

- [ ] Settings → Voice: "Transcription (Glance API)" reads `deepgram (nova-3, live, …)` and "Spoken replies" reads
      `deepgram aura (aura-2-athena-en)…`.
- [ ] Hold **Option + V**, say "what's Tesla at", let go: lime (listening) while held, thinking on release, then the orb
      moves while a calm voice says the price, and returns to the eye when it stops.
- [ ] Say "buy ten dollars of Tesla": the voice says "$10 of Tesla. Checking your vault's limits.", the confirm card
      appears after the preflight, and nothing is bought until you tap Confirm. Saying "yes" does not confirm.
- [ ] Say "don't buy Tesla" and "should I buy Tesla?": neither opens a buy.
- [ ] Stop the API and hold Option + V: the panel says the voice server isn't reachable and that it's trying the
      browser's speech recognition (in Brave, that it isn't available either). Typing still works.

The older checks below cover the microphone permission and the failure messages.

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

**Sounds**

- [ ] Tap **Option + G**. A short liquid sound plays as the orb starts melting into the panel. Press **Escape**, or
      click the panel's close button: the close sound plays as the panel starts draining back. Nothing sounds for hover
      cards, trades, voice, or docking and undocking.
- [ ] Tap Option + G and Escape quickly several times. Sounds never overlap: each one cuts off the last.
- [ ] Untick **Sounds** in settings. Opening and closing are silent. The setting is remembered after a restart. The
      volume is `sound.volume` in `lib/tokens.ts` (0.4).

**When the testnet isn't responding**

- [ ] Point the API's `RPC_URL` and `RPC_FALLBACK_URLS` at an address that doesn't answer, then restart it. The panel
      says "The Robinhood Chain testnet isn't responding right now. Trying again…", never "isn't a Glance vault".
      Restore the RPC: within about 30 seconds the vault and prices come back without a reload.

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
- [ ] Hold the key and say nothing: "I didn't hear anything. Hold ⌥ V while you speak, then let go." (No speech heard)
- [ ] Tap Option+V quickly (release before it starts): the orb goes back to idle with the same sentence; it never
      stays stuck on listening.
- [ ] Under the reason, a short label names the kind: No speech service, Microphone not allowed, No microphone found,
      No speech heard, or Listening was interrupted. In a dev build the console logs the raw SpeechRecognition error.
