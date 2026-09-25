# Glance security model

This page covers who can make Glance's agent trade a vault, and how the paid services behind the API (Deepgram,
AssemblyAI and Anthropic) are kept from being used by anyone who finds the URL.

## What the chain already guarantees

Every vault bounds its agent key on chain:

- The agent can buy and sell approved tokens, within the per-trade and daily caps, at a price no worse than the
  oracle's minus the slippage limit, until the agent's expiry.
- The agent can never withdraw, change limits or approvals, or extend its own expiry.

None of this changes. Everything below is an extra layer in front of those caps, not a replacement for them.

## The threat

The agent key lives on the API server, which signs trades for every vault that names it as agent. Before browser
sessions existed, anyone who knew a vault's address could `POST /trade` and make the agent trade that vault, within its
caps. That's not theft (the funds can't leave the vault), but it is someone else spending the owner's daily
allowance on stocks the owner didn't choose. The voice and Claude endpoints were also open, so anyone could spend the
project's Deepgram and Anthropic credit.

## Browser sessions, linked by the vault owner

1. **A key per browser.** The extension makes a session keypair once per browser (viem `generatePrivateKey`) and
   keeps it in `chrome.storage.local`. The private key never leaves the extension and is never logged. Only its
   address is shown, sent to the console, and sent with requests.
2. **The owner links it.** Glance's settings (or a trade card) open the console at
   `/link?vault=<vault>&session=<session address>&expires=<unix>`. The console states what's being allowed ("This
   browser may ask Glance to trade your vault within its limits until <date>. It can never withdraw.") and asks the
   connected wallet to sign EIP-712 typed data:

   ```
   domain  { name: "Glance", version: "1", chainId: 46630, verifyingContract: <vault> }
   GlanceSession { vault, sessionKey, expiresAt, issuedAt, nonce }
   ```

   This is a signature, not a transaction. `expiresAt` is at most 30 days away.
3. **The API checks it.** `POST /session/link` recovers the signer and requires it to equal `vault.owner()`, read on
   chain (V1 and V2 vaults alike). It also checks the domain (Glance v1, this chain, this vault), the expiry (at most
   30 days), `issuedAt` (not more than 5 minutes ahead, not more than a day old), and that the nonce is unused. Link
   and revoke nonces are kept for good, so an old link signature can't relink a browser after it was unlinked.
   Sessions are stored as `{ vault, sessionKey, expiresAt, revoked }` behind a `SessionStore` interface: JSON in
   `apps/api/.cache/sessions.json` here, swappable for a database when hosted.
4. **Unlinking.** The console Dashboard's "Linked browsers" card lists each session (short address, linked date,
   expiry) with Unlink. The owner signs `GlanceSessionRevoke { vault, sessionKey, nonce }`, then
   `POST /session/revoke`. The extension can also forget its own key ("Unlink this browser"); the next link makes a
   new one.

Only the owner's wallet can complete a link or an unlink. Any other wallet sees "Only the vault owner can link a
browser."

## Every trade request is signed

`POST /trade` is the only route that makes the agent sign a transaction. `GET /quote` only simulates: it reserves
nothing and sends nothing, so it stays open (rate-limited).

The extension signs each trade with its session key:

```
GlanceTradeRequest { vault, action: "trade", token: <ticker>, amount: <decimal string, as sent>, side,
                     maxSlippageBps: <0 = the vault's default>, deadline, requestNonce, bodyHash }
```

The deadline is 45 seconds ahead (the API allows at most 60). `requestNonce` is a random 128-bit number, and
`bodyHash` is keccak256 of the exact body bytes sent. The signature travels in headers: `x-glance-session`,
`x-glance-signature`, `x-glance-deadline` and `x-glance-nonce`.

Before the agent signs anything, the API checks these, in order:

| Check | Refused with (401) | What the extension shows |
|---|---|---|
| A session is named, linked to this vault, not revoked | `SESSION_REQUIRED` | Link this browser to your vault first. |
| The link hasn't expired | `SESSION_EXPIRED` | This browser's link to your vault has expired. Link it again. |
| The signature recovers to the session over these exact fields and body, with a deadline at most 60s ahead | `BAD_SIGNATURE` | That request's signature didn't check out, so nothing was sent. |
| The deadline hasn't passed, and the nonce is unused | `REPLAYED` | That request was already sent or is too old, so it wasn't sent again. Try once more. |

The signature is checked before the nonce is recorded, so nobody can burn a real request's nonce without the session
key. Seen nonces are kept until their deadline, at most 60 seconds; after that the deadline alone refuses the request.
Changing the body after signing (the amount, the vault, even one byte) is a `BAD_SIGNATURE`.

When a trade is refused for `SESSION_REQUIRED` or `SESSION_EXPIRED`, the trade card offers "Link this browser". Once
the owner has signed in the console, one tap sends the same buy again. The API runs the on-chain preflight again
before sending.

## Open vaults (recording day only)

Glance requires your own vault, so no vault is open by default: `OPEN_DEMO_VAULTS` is empty. For a recording, the
vaults listed there trade without a session:

- Each visitor (by IP) gets `DEMO_TRADES_PER_HOUR` trades an hour (default 10). Past that the API answers 429
  `DEMO_LIMIT`.
- Every open demo trade is logged with a short hash of the IP (not the IP itself) and the count so far.
- The vault's own on-chain caps still apply, as always.
- A browser that is linked to a demo vault is checked like any other (so a replayed request is still refused).

For recording day, `make link-demo-session SESSION=0x<session address from Glance's settings>` links a browser to the
team's vault with the deployer key (`PRIVATE_KEY`, or `LINK_PRIVATE_KEY`). The key is read from the environment and never
printed.

## Paid endpoints

- **Rate limits.** Per IP, 120 requests a minute overall and 10 a minute on `/trade` (both as before). Each of these
  groups has its own limit: `/resolve` 60 (plus `/resolve/names` 20), `/why` 20, `/showme` 10, `/chart` 60,
  `/portfolio` 60, `/voice` 60 (the audio stream included), and `/session` 30. When a request names a browser session
  (`x-glance-session`), the same limit also applies per session.
- **Daily caps.** Speech-to-text is capped at 1,800 seconds a day (`VOICE_STT_SECONDS_PER_DAY`, every provider's audio)
  and text-to-speech at 60,000 characters a day (`VOICE_TTS_CHARS_PER_DAY`), per UTC day, surviving restarts.
  AssemblyAI has its own 3,600 seconds (`ASSEMBLYAI_STT_SECONDS_PER_DAY`, counted as it bills: session wall-clock);
  when those run out, Deepgram listens instead. A session opened ahead of time is held 5 seconds, one per browser,
  and only for the panel opening or ⌥V going down (`ASSEMBLYAI_WARM`); live tests and benchmarks run only with
  `VOICE_LIVE_TESTS=1` and count under a separate test counter that no cap reads. When a direction runs out altogether, it rests until midnight UTC and
  Glance shows, in text only, "Voice is resting for today. You can still type." Pre-recorded lines and phrases served
  from memory never reach a provider, so they never count.
  Claude has its own daily budget (`LLM_DAILY_CALL_LIMIT`, see the API README).
- **Speech recognition keys.** `ASSEMBLYAI_API_KEY` and `DEEPGRAM_API_KEY` stay on the API: the extension streams its
  audio to `/voice/stream`, and the API streams it on. No key or temporary token is ever sent to the extension. Logs
  carry timings and lengths only, never audio or transcripts.
- **Size.** A command's audio is at most 30 seconds: the stream finishes there (the words so far are kept), and a longer
  upload is refused with 413. A JSON body is at most 64 KB (Show me's page context included); larger is refused with
  413. The extension keeps Show me requests under that by shortening the page text from the end and leaving out a
  screenshot that doesn't fit.

## CORS is not authentication

The API allows browser calls only from the origins in `CORS_ORIGINS`: the extension (its fixed ID,
`chrome-extension://gmcdcaoneeohbacbnafjdnkkoojgnogl`) and the console. That stops other web pages from using the API
through a visitor's browser. But anything outside a browser (curl, a script, a server) ignores CORS completely, which is
why trades are signed and the paid endpoints are rate-limited and capped.

## `/health`

In production (`NODE_ENV=production`), `/health` shows only `ok`, the chain, the block, `versions` and the feeds'
ages (the keeper's last write included): public, on-chain facts. The agent's address and balance, voice decisions,
budget internals and the keeper's pause file appear only with `?admin=<ADMIN_TOKEN>` (compared in constant time; query
strings never reach the log). Development keeps the full view.

## What this doesn't cover

- **A compromised browser.** Malware in the browser can read the session key from extension storage, and use it until
  the link expires or the owner unlinks it. The vault's caps bound what it can do, and it can never withdraw.
- **One API instance.** Seen request nonces and rate-limit counters live in memory. A multi-instance deployment should
  move them, and the session store, to shared storage (the `SessionStore` interface is the seam).
- **Restarts.** A request signed less than 60 seconds before a restart could be replayed once after it. The window is
  one deadline long, and the vault's caps still apply.
- **Per-IP limits.** A visitor behind a shared IP shares its limits. Set `TRUST_PROXY=true` only behind a proxy you
  control.
