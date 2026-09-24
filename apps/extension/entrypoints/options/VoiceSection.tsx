/**
 * Voice in settings: the one place Glance asks for the microphone ("Enable voice"), an honest diagnostics block with
 * each check shown separately (including which voice services the Glance API has), and tests for both halves: a real
 * command through the same path the pages use (recorded here, transcribed and answered by the API), and speaking with
 * the orb following the real playback.
 */
import { VOICE_RESTING } from "@glance/core/session";
import { useCallback, useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";

import { Orb, type OrbState } from "../../components/Orb";
import { api } from "../../lib/api";
import { hush, speak, startVoice, type VoiceSession } from "../../lib/voiceClient";
import { diagnose, requestMic, type VoiceDiagnostics } from "../../lib/voiceDiagnostics";
import { markVoiceEnabled, voiceState, type VoiceState } from "../../lib/voicePrefs";
import { reasonFor, type VoiceCode } from "../../lib/voiceReasons";

export function VoiceSection({ voiceKey }: { voiceKey: string }) {
  const [diag, setDiag] = useState<VoiceDiagnostics | null>(null);
  const [stored, setStored] = useState<VoiceState | null>(null);
  const [asking, setAsking] = useState(false);
  const [orb, setOrb] = useState<OrbState>("idle");
  const [line, setLine] = useState("");
  const [server, setServer] = useState<{ transcription: string; speech: string; intent: string; ok: boolean; reachable: boolean } | null>(null);
  const session = useRef<VoiceSession | null>(null);
  const markUrl = browser.runtime.getURL("/glance-mark.png");

  const refresh = useCallback(async () => {
    const [d, s, v] = await Promise.all([diagnose(), api.voiceStatus(), voiceState.getValue()]);
    setDiag(d);
    setStored(v);
    setServer(
      s.ok
        ? { ...s.data, ok: s.data.available.transcription, reachable: true }
        : { transcription: "unreachable", speech: "unreachable", intent: "unreachable", ok: false, reachable: false },
    );
    if (import.meta.env.DEV) console.info(`[glance] voice diagnostics in ${d.browser.name} ${d.browser.version}`, d);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = async () => {
    setAsking(true);
    // Granted here, the permission belongs to Glance's own origin: the offscreen document reuses it without asking.
    if ((await requestMic()) === "granted") await markVoiceEnabled();
    setAsking(false);
    await refresh();
  };

  // Opened by Glance because voice needed enabling (at most once per browser session): go straight to the button.
  useEffect(() => {
    if (location.hash === "#voice") document.getElementById("voice")?.scrollIntoView({ block: "center" });
  }, []);

  const reason = (code: VoiceCode) => (diag ? reasonFor(code, diag.browser) : code);

  const testListen = () => {
    if (session.current) return session.current.stop();
    let heard = "";
    let failed = false;
    let replied = false;
    setOrb("listening");
    setLine("Listening… say “what's Tesla at”, then click Stop.");
    session.current = startVoice({
      onReleased: () => setOrb("thinking"),
      onInterim: (t) => setLine(`“${t}”`),
      onFallback: () => setLine("The Glance voice server isn't available, so this uses the browser's speech recognition."),
      onFinal: (t) => {
        heard = t;
      },
      onIntent: (it) => {
        replied = true;
        setLine(`Heard “${heard}” → ${it.intent}${it.symbol ? ` ${it.symbol}` : ""}${it.amount ? ` $${it.amount}` : ""}. Reply: “${it.reply}”`);
      },
      onReplyStart: () => setOrb("speaking"),
      onReplyEnd: () => setOrb("idle"),
      onTiming: (t) => setLine((l) => `${l} (${t.transcript}ms to the words${t.speaking ? `, ${t.speaking}ms to the voice` : ""})`),
      onError: (code) => {
        failed = true;
        setLine(reason(code));
      },
      onEnd: () => {
        session.current = null;
        if (!replied) setOrb("idle");
        if (!failed && !replied) setLine(heard ? `Heard “${heard}”. Voice works.` : reason("no-speech"));
      },
    });
  };

  const testSpeak = () => {
    hush();
    const text = "Tesla is at $250. Confirm?";
    setLine(`Saying “${text}”`);
    void speak(text, true, { onStart: () => setOrb("speaking"), onEnd: () => setOrb("idle") }).then((outcome) => {
      if (outcome === "resting") setLine(VOICE_RESTING);
      else if (outcome === "unavailable") setLine("Glance's voice isn't available right now, so replies are shown, not spoken.");
      else if (outcome === "cut") setLine("Glance's voice stopped part way. The reply stays written.");
    });
  };

  // "Voice enabled" once the user turned it on and the browser hasn't blocked it; a "prompt" answer from the
  // permissions API alone doesn't undo that (Brave can report "prompt" while the mic works).
  const granted = diag?.micPermission === "granted" || (Boolean(stored?.on) && diag?.micPermission !== "denied");
  const blocked = diag?.micPermission === "denied";
  const status = !diag
    ? ""
    : blocked
        ? reason("mic-denied")
        : diag.micDevice === false
          ? reason("no-mic")
          : granted
            ? server?.ok
              ? `Voice is on. Hold ⌥ ${voiceKey || "V"}, or use the mic button in Glance's panel, to talk.`
              : `The microphone is ready, but the Glance API has no transcription service${server?.reachable ? "" : " (it isn't reachable)"}: voice falls back to this browser's speech recognition.`
            : "Click “Enable voice” once. Your browser will ask to let Glance use your microphone.";

  return (
    <section className="g-card" aria-labelledby="voice">
      <div className="g-section">
        <h2 id="voice" className="g-ui">
          Voice
        </h2>
        <div className="g-row" style={{ gap: 12 }}>
          <button className="g-btn g-btn-primary" onClick={() => void enable()} disabled={asking || diag?.micPermission === "granted"}>
            {granted ? "Voice enabled" : asking ? "Waiting for your answer…" : "Enable voice"}
          </button>
          <span className="g-meta" role="status">
            {status}
          </span>
        </div>
        <span className="g-meta">Typing always works, whatever this says.</span>
      </div>

      {diag && (
        <div className="g-section">
          <span className="g-ui">Diagnostics</span>
          <dl className="g-facts" aria-label="Voice diagnostics">
            <dt>Browser</dt>
            <dd>
              {diag.browser.name} {diag.browser.version}
            </dd>
            <dt>Transcription (Glance API)</dt>
            <dd>{server?.transcription ?? "…"}</dd>
            <dt>Spoken replies (Glance API)</dt>
            <dd>{server?.speech ?? "…"}</dd>
            <dt>Understanding (Glance API)</dt>
            <dd>{server?.intent ?? "…"}</dd>
            <dt>Browser speech recognition</dt>
            <dd>{diag.recognition ? "available (fallback only)" : "missing in this build (not needed: transcription is server-side)"}</dd>
            <dt>Microphone permission</dt>
            <dd>{{ granted: "granted to Glance", prompt: "not asked yet", denied: "blocked", unknown: "unknown" }[diag.micPermission]}</dd>
            <dt>Microphone device</dt>
            <dd>{diag.micDevice === null ? "unknown" : diag.micDevice ? "found" : "none found"}</dd>
          </dl>
          <div className="g-row" style={{ gap: 8 }}>
            <button className="g-btn" onClick={testListen} disabled={!granted}>
              {orb === "listening" ? "Stop" : "Test listening"}
            </button>
            <button className="g-btn" onClick={testSpeak} disabled={!server?.reachable}>
              Test speaking
            </button>
            <button className="g-btn g-btn-ghost" onClick={() => void refresh()}>
              Check again
            </button>
          </div>
          <div className="g-row" style={{ gap: 12, minHeight: 44 }} aria-live="polite">
            <Orb state={orb} size={40} markUrl={markUrl} />
            <span className="g-body">{line}</span>
          </div>
        </div>
      )}
    </section>
  );
}
