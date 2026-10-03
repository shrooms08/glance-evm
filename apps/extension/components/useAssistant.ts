/**
 * The assistant: turns speech or typed text into a command and acts on it. Shared by the floating orb and the
 * docked side panel. It never trades on a guess: a buy or a sell always goes through the preflight and an explicit
 * confirm tap.
 *
 * Voice (Option+V): the offscreen document records and streams the audio to the Glance API, which transcribes it
 * (Deepgram), works out what was meant (Claude, validated against our catalog and against what was actually said),
 * and speaks a reply (Deepgram Aura). The orb shows listening while the key is held, thinking from the release, and
 * speaking exactly while the reply's audio plays. A spoken command lands on the same cards as a typed one; a spoken
 * "yes" never confirms a trade (the confirm is a tap). If the API can't be reached, the browser's own speech
 * recognition is tried instead, and the panel says so.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { parseCommand } from "../lib/commands";
import { allowedSymbols, describeLegs, draftBasket, findBasket, listBaskets, saveBasket, userBaskets } from "../lib/baskets";
import { ageHours, priceUsd, until } from "../lib/format";
import { isAddress } from "../lib/settings";
import { keyLabel } from "../lib/hotkeys";
import { talkKey } from "../lib/talkMode";
import { hush, speak, startVoice, type VoiceSession } from "../lib/voiceClient";
import type { FallbackReason, VoiceCommandContext, VoiceIntent, VoiceTiming } from "../lib/voiceMessages";
import { detectBrowser, failureKind, micSettingsUrl, reasonFor, type VoiceCode, type VoiceFailureKind } from "../lib/voiceReasons";
import { useGlance } from "./context";
import { tick } from "../lib/onboarding";
import { spokenWhy } from "./Why";
import { LINES, NOT_HEARD } from "@glance/core/persona";
import { VOICE_RESTING } from "@glance/core/session";
import { CUT_NOTE, noVoiceNote } from "../lib/showMe";
import type { SellSpec } from "./SellCard";
import { lastTradesReply, NO_VAULT_TRADES } from "@glance/core/trades";

/** A sell command's amount as the card's spec: dollars, or all or half of the holding. */
function sellSpec(amount: string | null | undefined, fraction: "1" | "0.5" | undefined): SellSpec | undefined {
  if (fraction) return { fraction };
  return amount ? { usd: amount } : undefined;
}

/** The short label under the reason, so the kinds of failure are told apart at a glance. */
const KIND_META: Record<VoiceFailureKind, string> = {
  "no-service": "No speech service · you can type instead",
  "mic-denied": "Microphone not allowed · you can type instead",
  "no-mic": "No microphone found · you can type instead",
  "no-speech": "No speech heard",
  aborted: "Listening was interrupted",
  other: "Voice stopped · you can type instead",
};

/** Past this, the panel says it's still working rather than appearing frozen. */
export const SLOW_VOICE_MS = 3_000;

const FALLBACK_NOTE: Record<FallbackReason, string> = {
  "api-unreachable": "The Glance voice server isn't reachable, so I'm using this browser's speech recognition.",
  "no-provider": "The Glance API has no transcription service set up, so I'm using this browser's speech recognition.",
};

const browserInfo = detectBrowser(navigator as unknown as Parameters<typeof detectBrowser>[0]);
if (import.meta.env.DEV) console.info(`[glance] voice: running in ${browserInfo.name} ${browserInfo.version}`);

/** The sentence for a voice failure, specific to this browser. Typing always still works. */
export function voiceReason(code: VoiceCode): string {
  if (code === "transcription-failed") return "The voice server couldn't transcribe that. Try again, or type instead.";
  if (code === "voice-resting") return VOICE_RESTING;
  return reasonFor(code, browserInfo);
}

export type AssistantCard =
  | { kind: "company"; symbol: string; autoAmount?: string; key: number }
  /** Selling: `spec` quotes straight away ("sell all my Palantir"); without it, the card asks how much. */
  | { kind: "sell"; symbol: string; spec?: SellSpec; voice?: boolean; key: number }
  | { kind: "spent" }
  | { kind: "portfolio"; key: number; tab?: "positions" | "journal" }
  | { kind: "why"; symbol: string; key: number }
  | { kind: "chart"; symbol: string; key: number; range?: import("@glance/core/chart").ChartRange }
  /** The Baskets view; `buy` opens straight on a basket's confirm card, `notice` says what just happened. */
  | { kind: "baskets"; key: number; buy?: { basketId: string; amount: string }; notice?: string }
  /** One short question with a few answers (the chart lens asking which chart, or offering the lens). */
  | { kind: "choice"; key: number; question: string; options: Array<{ label: string; run(): void }> }
  /** 2 or 3 stocks side by side, rebased to 100 (`data`: already fetched for the typed path). */
  | { kind: "compare"; key: number; symbols: string[]; range: import("@glance/core/chart").ChartRange; data?: import("../lib/api-types").ChartFactsView; market?: boolean }
  | null;

export interface AssistantOptions {
  context?: () => VoiceCommandContext;
  /**
   * A chart was asked for ("show me Tesla's chart"). On the page, this opens the side panel on it; in the side panel
   * the chart card is simply shown.
   */
  onChart?(symbol: string): void;
  /** A question for Show me ("what's this article saying?", "how do I withdraw?"): answered with the page in view. */
  onAsk?(question: string): void;
  /** Developer check ("glance test drawing"): draws every Show me shape on the selection. */
  onTestDrawing?(): void;
  /**
   * A yes or no, when Glance has asked something other than a trade confirm ("Want me to pull up my own?"). True when
   * it answered that question (a spoken yes can do that: it moves no money). Else a yes stays a trade confirm.
   */
  onYesNo?(yes: boolean): boolean;
  /**
   * A short answer to a question Glance asked about the page's chart (TradingView's chart page: "five days", "1M", or
   * "yes"), said or typed. True when it answered that question; else the words go on as usual.
   */
  onAnswer?(said: string): boolean;
}

export function useAssistant(opts: AssistantOptions = {}) {
  // Read through a ref: the callbacks below don't re-create when the page passes a new handler.
  const onChart = useRef(opts.onChart);
  onChart.current = opts.onChart;
  const onAsk = useRef(opts.onAsk);
  onAsk.current = opts.onAsk;
  const onTestDrawing = useRef(opts.onTestDrawing);
  onTestDrawing.current = opts.onTestDrawing;
  const onYesNo = useRef(opts.onYesNo);
  onYesNo.current = opts.onYesNo;
  const onAnswer = useRef(opts.onAnswer);
  onAnswer.current = opts.onAnswer;
  const g = useGlance();
  const [card, setCard] = useState<AssistantCard>(null);
  const [heard, setHeard] = useState("");
  const [listening, setListening] = useState(false);
  const [timing, setTiming] = useState<VoiceTiming | null>(null);
  /** The browser's microphone setting to copy, when its grant ran out (shown with a Copy button). */
  const [micHint, setMicHint] = useState<{ line: string; url: string } | null>(null);
  /** Increments to tell the open company card to confirm (+1) or cancel (-1) its pending review (typed only). */
  const [decision, setDecision] = useState<{ n: number; confirm: boolean }>({ n: 0, confirm: true });
  const listener = useRef<VoiceSession | null>(null);
  /** Set by Escape (cancelListening): the session ends without a "didn't catch that". */
  const cancelled = useRef(false);
  /** The user's basket names, sent with each voice session so speech recognition expects them. */
  const basketNames = useRef<string[]>([]);
  useEffect(() => {
    const load = () =>
      void listBaskets()
        .then((b) => (basketNames.current = b.map((x) => x.name).slice(0, 10)))
        .catch(() => {});
    load();
    return userBaskets.watch(load);
  }, []);
  const seq = useRef(0);
  const contextRef = useRef(opts.context);
  contextRef.current = opts.context;

  // What the API may use to understand "why?": the last refusal and the last thing said.
  const lastGuard = useRef<{ code: string; message: string } | null>(null);
  const lastReply = useRef<string | null>(null);
  useEffect(() => {
    if (g.orb.state === "blocked" && g.orb.line) lastGuard.current = { code: g.orb.meta.replace(/^Guard · /, ""), message: g.orb.line };
    if (g.orb.line) lastReply.current = g.orb.line;
  }, [g.orb]);

  const say = useCallback(
    async (line: string, meta = "") => {
      // Show the line at once; the orb moves only while the voice is actually speaking.
      g.setOrb({ state: "idle", line, meta });
      const outcome = await speak(line, g.voiceReplies, {
        onStart: () => g.setOrb({ state: "speaking", line, meta }),
        onEnd: () => g.setOrb({ state: "idle", line, meta }),
      });
      // Never another voice: if Glance's stopped part way, or there's none right now, the line stays written.
      if (outcome === "cut") g.setOrb({ state: "idle", line, meta: CUT_NOTE });
      else if (outcome === "unavailable" || outcome === "resting") g.setOrb({ state: "idle", line, meta: noVoiceNote(outcome) });
    },
    [g],
  );

  /** Typed commands (and the browser-fallback transcript), parsed here. */
  const run = useCallback(
    async (text: string, source: "typed" | "voice" = "typed") => {
      if (onAnswer.current?.(text)) return setHeard(text);
      const baskets = await listBaskets(g.catalog.map((s) => s.symbol));
      const cmd = parseCommand(
        text,
        g.catalog.map((s) => ({ symbol: s.symbol, aliases: s.aliases })),
        baskets.map((b) => b.name),
        contextRef.current?.().pageStock ?? null,
      );
      setHeard(text);
      void tick("ask"); // "Getting started": asked Glance something
      switch (cmd.kind) {
        case "buy":
          setCard({ kind: "company", symbol: cmd.symbol, autoAmount: cmd.amount, key: ++seq.current });
          return;
        case "sell": {
          // The same rule as a buy: the confirm card, the on-chain preflight, and nothing moves without the tap.
          const spec = sellSpec(cmd.amount, cmd.fraction);
          setCard({ kind: "sell", symbol: cmd.symbol, spec, voice: source === "voice", key: ++seq.current });
          if (!spec) return say(LINES.howMuchSell(g.catalog.find((s) => s.symbol === cmd.symbol)?.name ?? cmd.symbol));
          return;
        }
        case "sellBasket":
          return say(LINES.basketSell);
        case "notTradable":
          return say(LINES.notTradable(cmd.name, g.catalog.map((s) => s.symbol)), "Your vault's approved stocks");
        case "price": {
          setCard({ kind: "company", symbol: cmd.symbol, key: ++seq.current });
          g.setOrb({ state: "thinking", line: `Checking ${cmd.symbol}`, meta: "" });
          const res = await api.price(cmd.symbol, g.vaultAddress || undefined);
          if (!res.ok) return say(res.message);
          const p = res.data;
          const market = p.marketState === "OPEN" ? "the market's open" : p.marketState === "CLOSED" ? "the market's closed" : "that price is too old to trade on";
          // The live market price when there is one; the vault's own (oracle) price is shown beside it.
          if (p.live) return say(`${p.name} is at ${priceUsd(p.live.price)}, and ${market}.`, `${cmd.symbol} · live (${p.live.source}) · vault trades at ${priceUsd(p.price.value)}`);
          return say(`${p.name} is at ${priceUsd(p.price.value)}. The price is ${ageHours(p.ageSeconds)} old and ${market}.`, `${cmd.symbol} · oracle ${p.priceSourceKind}`);
        }
        case "spent": {
          if (!isAddress(g.vaultAddress)) return say(LINES.noVaultSpent);
          setCard({ kind: "spent" });
          const res = await api.vault(g.vaultAddress);
          if (!res.ok) return say(res.message);
          const w = res.data.buyWindow;
          const frees = w.nextReleaseInSeconds ? ` The oldest buy frees up in ${until(w.nextReleaseInSeconds)}.` : "";
          return say(`You've spent ${w.used.formatted} of your ${w.limit.formatted} in the last 24 hours. ${w.remaining.formatted} left.${frees}`, "Rolling 24h window");
        }
        case "lastTrades": {
          // Read only, from the vault's own events.
          if (!isAddress(g.vaultAddress)) return say(NO_VAULT_TRADES);
          const res = await api.activity(g.vaultAddress);
          if (!res.ok) return say(res.message);
          return say(lastTradesReply(res.data.items, cmd.ask), "Activity");
        }
        case "portfolio": {
          setCard({ kind: "portfolio", key: ++seq.current });
          if (!isAddress(g.vaultAddress)) return say(LINES.noVaultPortfolio);
          const res = await api.portfolio(g.vaultAddress);
          if (!res.ok) return say(res.message);
          return say(res.data.sentence, "Portfolio");
        }
        case "why": {
          setCard({ kind: "why", symbol: cmd.symbol, key: ++seq.current });
          const name = g.catalog.find((s) => s.symbol === cmd.symbol)?.name ?? cmd.symbol;
          g.setOrb({ state: "thinking", line: `Checking the news on ${name}`, meta: "" });
          const res = await api.why(cmd.symbol);
          if (!res.ok) return say(res.message);
          return say(spokenWhy(res.data, name), "Sources below");
        }
        case "chart": {
          setCard({ kind: "chart", symbol: cmd.symbol, key: ++seq.current });
          onChart.current?.(cmd.symbol);
          const name = g.catalog.find((s) => s.symbol === cmd.symbol)?.name ?? cmd.symbol;
          return say(LINES.hereIsChart(name), "Chainlink price history");
        }
        case "baskets":
          setCard({ kind: "baskets", key: ++seq.current });
          return say(baskets.length === 1 ? "Here's your basket." : `Here are your ${baskets.length} baskets.`, "Baskets");
        case "makeBasket": {
          if (cmd.unmatched.length) return say(`I don't know ${cmd.unmatched.join(" or ")}. A basket can hold only stocks Glance can trade.`);
          if (cmd.symbols.length === 0) return say("Which stocks should go in it?");
          try {
            const saved = await saveBasket(draftBasket(cmd.name, cmd.symbols, cmd.weights), allowedSymbols(g.vault, g.catalog));
            const line = `Saved ${saved.name}: ${describeLegs(saved.legs)}.`;
            setCard({ kind: "baskets", key: ++seq.current, notice: line });
            return say(line, "Baskets");
          } catch (err) {
            setCard({ kind: "baskets", key: ++seq.current });
            return say((err as Error).message);
          }
        }
        case "buyBasket": {
          const basket = findBasket(cmd.basket, baskets);
          if (!basket) {
            setCard({ kind: "baskets", key: ++seq.current });
            return say(`You don't have a basket called ${cmd.basket}.`, "Baskets");
          }
          // The same rule as a single buy: the confirm card, every leg preflighted, and nothing moves without the tap.
          setCard({ kind: "baskets", key: ++seq.current, buy: { basketId: basket.id, amount: cmd.amount } });
          return;
        }
        case "compare": {
          // Every number said comes from the computed facts (GET /chart/:symbols/facts), never from a model.
          g.setOrb({ state: "thinking", line: `Comparing ${cmd.symbols.join(" and ")}`, meta: "" });
          const res = await api.chartFacts(cmd.symbols, cmd.range, isAddress(g.vaultAddress) ? g.vaultAddress : undefined);
          setCard({ kind: "compare", key: ++seq.current, symbols: cmd.symbols, range: cmd.range, ...(res.ok ? { data: res.data } : {}) });
          if (!res.ok) return say(res.message);
          return say(res.data.comparison?.sentence ?? "", "Rebased to 100 · from Chainlink prices");
        }
        case "compareAny": {
          // Any US stocks, by name: the API finds the tickers; every number said is computed from the market's candles.
          g.setOrb({ state: "thinking", line: `Comparing ${cmd.names.join(" and ")}`, meta: "" });
          const res = await api.compareAny(cmd.names, cmd.range);
          if (!res.ok) return say(res.message);
          setCard({ kind: "compare", key: ++seq.current, symbols: res.data.symbols, range: cmd.range, market: true });
          return say(res.data.sentence, res.data.source);
        }
        case "ask":
          if (onAsk.current) return onAsk.current(cmd.question);
          return say(LINES.cantThink);
        case "testDrawing":
          if (onTestDrawing.current) return onTestDrawing.current();
          return say("Test drawing works on a web page, with developer tools on in settings.");
        case "confirm":
        case "cancel":
          // First, a question that isn't a trade ("Want me to pull up my own?").
          if (onYesNo.current?.(cmd.kind === "confirm")) return;
          // Only a tap (or a typed "yes") confirms: a misheard word must never move money.
          if (source === "voice") return say(LINES.tapToConfirm);
          setDecision((d) => ({ n: d.n + 1, confirm: cmd.kind === "confirm" }));
          return;
        default:
          return say(LINES.didntCatch, cmd.heard ? `Heard “${cmd.heard}”` : "");
      }
    },
    [g, say],
  );

  /** What the API understood: open the same cards as the typed path. The reply is already being spoken. */
  const applyIntent = useCallback(
    (it: VoiceIntent, said: string) => {
      const meta = `Heard “${said}”`;
      if (onAnswer.current?.(said)) return;
      // A spoken yes or no to a question that isn't a trade ("Want me to pull up my own?").
      if (/^(yes|yeah|yep|sure|ok|okay|please|please do|do it|go ahead|pull it up|no|nope|no thanks|not now)[.!]?$/i.test(said.trim())) {
        if (onYesNo.current?.(!/^(no|nope|no thanks|not now)/i.test(said.trim()))) return;
      }
      switch (it.intent) {
        case "buy":
          // The same confirm card as typing: preflight, review, and nothing moves without the tap. A stock outside
          // the catalog opens nothing: the reply (already speaking) says the vault doesn't trade it.
          if (it.symbol) setCard({ kind: "company", symbol: it.symbol, autoAmount: it.amount ?? undefined, key: ++seq.current });
          break;
        case "sell":
          // The reply (already speaking) named the sell; the card quotes it and waits for the tap. A basket names no
          // stock: the reply alone asks for one.
          if (it.symbol) setCard({ kind: "sell", symbol: it.symbol, spec: sellSpec(it.amount, it.fraction), voice: true, key: ++seq.current });
          break;
        case "price":
          setCard({ kind: "company", symbol: it.symbol!, key: ++seq.current });
          break;
        case "spend-so-far":
          if (isAddress(g.vaultAddress)) setCard({ kind: "spent" });
          break;
        case "portfolio":
          setCard({ kind: "portfolio", key: ++seq.current });
          break;
        case "why":
          // The API is already speaking the summary; the card shows it with its sources as links.
          if (it.symbol) setCard({ kind: "why", symbol: it.symbol, key: ++seq.current });
          break;
        case "chart":
          if (it.symbol) {
            setCard({ kind: "chart", symbol: it.symbol, key: ++seq.current });
            onChart.current?.(it.symbol);
          }
          break;
        case "compare":
          // The API is already speaking the comparison (built from the computed facts); the card draws it.
          // A stock outside the catalog: every line from the market's own prices (the spoken numbers came from them).
          if (it.symbols && it.symbols.length >= 2) {
            const market = it.symbols.some((s) => !g.catalog.some((c) => c.symbol === s));
            setCard({ kind: "compare", key: ++seq.current, symbols: it.symbols, range: it.range ?? "1W", ...(market ? { market } : {}) });
          }
          break;
        case "basket-buy":
        case "basket-make":
        case "baskets":
          // Baskets are named in this browser: read the words here, like typed text (a buy still needs the tap).
          void run(said, "voice");
          return;
        case "ask":
          // Show me answers with the page in view, and speaks for itself.
          if (onAsk.current) {
            onAsk.current(said);
            return;
          }
          break;
      }
      // The reply is about to play: stay on thinking (no flicker to idle) until the audio actually starts. With spoken
      // replies off, there is nothing to wait for.
      g.setOrb({ state: g.voiceReplies ? "thinking" : "idle", line: it.reply, meta });
    },
    [g, run],
  );

  /** Voice failures never block typing: the reason shows in the orb line and the text box stays ready. */
  const voiceFailed = useCallback(
    (code: VoiceCode, note = "") => {
      // Nothing heard after a real hold: the key's own name in it (the worker says it too).
      const reason = code === "not-heard" ? NOT_HEARD(`⌥${(g.voiceKey || "V").toUpperCase()}`) : voiceReason(code);
      const line = `${note ? `${note} ` : ""}${reason}`;
      if (code === "mic-temporary" || code === "mic-blocked-again") setMicHint({ line: voiceReason(code), url: micSettingsUrl(browserInfo) });
      if (import.meta.env.DEV) console.info(`[glance] voice error "${code}" (${failureKind(code)}) in ${browserInfo.name} ${browserInfo.version}`);
      g.setOrb({ state: "idle", line, meta: KIND_META[failureKind(code)] });
    },
    [g],
  );

  const startListening = useCallback(() => {
    if (listener.current) return;
    cancelled.current = false;
    hush();
    setHeard("");
    setMicHint(null);
    setListening(true);
    g.setOrb({ state: "listening", line: "Listening…", meta: g.conversation ? "Just talk: I'll send it when you finish" : "Release to send" });
    let failed = false;
    let finalText = "";
    let fallback = "";
    let intentSeen = false;
    let slow: ReturnType<typeof setTimeout> | undefined;
    const context: VoiceCommandContext = {
      ...contextRef.current?.(),
      lastGuard: lastGuard.current,
      lastReply: lastReply.current,
      openCard: card?.kind === "company" || card?.kind === "sell" ? card.symbol : null,
    };
    listener.current = startVoice(
      {
        onFallback: (reason) => {
          fallback = FALLBACK_NOTE[reason];
          g.setOrb({ state: "listening", line: "Listening…", meta: fallback });
        },
        onReleased: () => {
          setListening(false);
          g.setOrb({ state: "thinking", line: "Thinking…", meta: fallback || "" });
          // Never look frozen: past 3s, say so.
          slow = setTimeout(() => {
            if (!intentSeen) g.setOrb({ state: "thinking", line: "Still working on it. The voice service is slower than usual.", meta: fallback || "" });
          }, SLOW_VOICE_MS);
        },
        onInterim: (t) => setHeard(t),
        onFinal: (t) => {
          finalText = t;
          setHeard(t);
        },
        onIntent: (it) => {
          intentSeen = true;
          clearTimeout(slow);
          applyIntent(it, finalText);
        },
        onReplyStart: () => g.setOrb({ state: "speaking" }),
        onReplyEnd: () => g.setOrb({ state: "idle" }),
        // The reply's voice stopped part way: the reply stays written in the panel (never finished in another voice).
        onReplyCut: () => g.setOrb({ state: "idle", meta: CUT_NOTE }),
        onTiming: (t) => {
          setTiming(t);
          if (import.meta.env.DEV) console.info(`[glance] voice latency from release: transcript ${t.transcript}ms, intent ${t.intent ?? "-"}ms, speaking ${t.speaking ?? "-"}ms (${t.via})`);
        },
        onError: (code) => {
          failed = true;
          clearTimeout(slow);
          voiceFailed(code, fallback);
        },
        onEnd: () => {
          clearTimeout(slow);
          listener.current = null;
          setListening(false);
          // Cancelled (Escape): nothing to say.
          if (cancelled.current) return g.setOrb({ state: "idle" });
          if (failed || intentSeen) return;
          // No intent: the browser fallback (or the API couldn't answer). Parse it here, like typed text.
          if (finalText) void run(finalText, "voice");
          else g.setOrb({ state: "idle", line: LINES.noSpeech, meta: KIND_META["no-speech"] });
        },
      },
      {
        context,
        vault: isAddress(g.vaultAddress) ? g.vaultAddress : undefined,
        // Conversation mode (a setting), and the user's basket names as extra words for speech recognition.
        listen: {
          conversation: g.conversation,
          keyterms: basketNames.current,
          // Said when nothing was heard: pre-recorded for ⌥V, spoken live for another key.
          notHeard: (g.voiceKey || "V").toUpperCase() === "V" ? LINES.notHeardSpoken : `Didn't catch that. Hold Option ${(g.voiceKey || "V").toUpperCase()} and try again.`,
        },
      },
    );
  }, [g, run, voiceFailed, applyIntent, card]);

  const stopListening = useCallback(() => listener.current?.stop(), []);
  /** Escape: stop listening and send nothing. Says whether there was anything to cancel. */
  const cancelListening = useCallback(() => {
    if (!listener.current) return false;
    cancelled.current = true;
    listener.current.abort();
    return true;
  }, []);
  /** Option+V went down / came up (lib/talkMode: hold-to-talk, or conversation mode). */
  const talk = useCallback(
    (edge: "down" | "up") => {
      const act = talkKey(edge, { conversation: g.conversation, listening: Boolean(listener.current) });
      if (act === "start") startListening();
      else if (act === "stop") stopListening();
    },
    [g.conversation, startListening, stopListening],
  );
  const talkDown = useCallback(() => talk("down"), [talk]);
  const talkUp = useCallback(() => talk("up"), [talk]);

  return { card, setCard, heard, listening, decision, run, startListening, stopListening, cancelListening, talkDown, talkUp, voiceFailed, timing, micHint, clearMicHint: () => setMicHint(null) };
}
