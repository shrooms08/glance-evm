/**
 * The assistant: turns speech or typed text into a command and acts on it. Shared by the floating orb and the
 * docked side panel. It never trades on a guess: a buy always goes through the preflight and an explicit confirm.
 */
import { useCallback, useRef, useState } from "react";

import { api } from "../lib/api";
import { parseCommand } from "../lib/commands";
import { ageHours, priceUsd, until } from "../lib/format";
import { isAddress } from "../lib/settings";
import { listen, speak, stopSpeaking, voiceSupported, type Listener } from "../lib/voice";
import { useGlance } from "./context";

export type AssistantCard =
  | { kind: "company"; symbol: string; autoAmount?: string; key: number }
  | { kind: "spent" }
  | null;

export function useAssistant() {
  const g = useGlance();
  const [card, setCard] = useState<AssistantCard>(null);
  const [heard, setHeard] = useState("");
  const [listening, setListening] = useState(false);
  /** Increments to tell the open company card to confirm (+1) or cancel (-1) its pending review. */
  const [decision, setDecision] = useState<{ n: number; confirm: boolean }>({ n: 0, confirm: true });
  const listener = useRef<Listener | null>(null);
  const seq = useRef(0);

  const say = useCallback(
    async (line: string, meta = "") => {
      g.setOrb({ state: "speaking", line, meta });
      await speak(line, g.voiceReplies);
      g.setOrb({ state: "idle", line, meta });
    },
    [g],
  );

  const run = useCallback(
    async (text: string) => {
      const cmd = parseCommand(text, g.catalog.map((s) => ({ symbol: s.symbol, aliases: s.aliases })));
      setHeard(text);
      switch (cmd.kind) {
        case "buy":
          setCard({ kind: "company", symbol: cmd.symbol, autoAmount: cmd.amount, key: ++seq.current });
          return;
        case "price": {
          setCard({ kind: "company", symbol: cmd.symbol, key: ++seq.current });
          g.setOrb({ state: "thinking", line: `Checking ${cmd.symbol}`, meta: "" });
          const res = await api.price(cmd.symbol, g.vaultAddress || undefined);
          if (!res.ok) return say(res.message);
          const p = res.data;
          const market = p.marketState === "OPEN" ? "the market's open" : p.marketState === "CLOSED" ? "the market's closed" : "that price is too old to trade on";
          return say(`${p.name} is at ${priceUsd(p.price.value)}. The price is ${ageHours(p.ageSeconds)} old and ${market}.`, `${cmd.symbol} · oracle ${p.priceSourceKind}`);
        }
        case "spent": {
          if (!isAddress(g.vaultAddress)) return say("Add your vault in settings and I can tell you what you've spent.");
          setCard({ kind: "spent" });
          const res = await api.vault(g.vaultAddress);
          if (!res.ok) return say(res.message);
          const w = res.data.buyWindow;
          const frees = w.nextReleaseInSeconds ? ` The oldest buy frees up in ${until(w.nextReleaseInSeconds)}.` : "";
          return say(`You've spent ${w.used.formatted} of your ${w.limit.formatted} in the last 24 hours. ${w.remaining.formatted} left.${frees}`, "Rolling 24h window");
        }
        case "confirm":
          setDecision((d) => ({ n: d.n + 1, confirm: true }));
          return;
        case "cancel":
          setDecision((d) => ({ n: d.n + 1, confirm: false }));
          return;
        default:
          return say("I didn't catch that. Try “buy ten dollars of Tesla” or “what's Tesla at”.", cmd.heard ? `Heard “${cmd.heard}”` : "");
      }
    },
    [g, say],
  );

  const startListening = useCallback(() => {
    if (listener.current) return;
    stopSpeaking();
    if (!voiceSupported()) {
      void say("Voice isn't available in this browser. Type your request instead.");
      return;
    }
    setHeard("");
    setListening(true);
    g.setOrb({ state: "listening", line: "Listening…", meta: "Release to send" });
    listener.current = listen({
      onInterim: (t) => setHeard(t),
      onFinal: (t) => {
        listener.current = null;
        setListening(false);
        if (t) void run(t);
        else g.setOrb({ state: "idle", line: "I didn't hear anything.", meta: "" });
      },
      onError: (message) => {
        listener.current = null;
        setListening(false);
        void say(message);
      },
    });
    if (!listener.current) {
      setListening(false);
      void say("I couldn't start the microphone. Type your request instead.");
    }
  }, [g, run, say]);

  const stopListening = useCallback(() => listener.current?.stop(), []);

  return { card, setCard, heard, listening, decision, run, startListening, stopListening };
}
