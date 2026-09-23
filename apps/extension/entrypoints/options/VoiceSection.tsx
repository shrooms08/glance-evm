/**
 * Voice in settings: the one place Glance asks for the microphone ("Enable voice"), an honest diagnostics block with
 * each check shown separately, and tests for both halves (listening through the offscreen document the pages use,
 * and speaking with the orb following the real utterance).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";

import { Orb, type OrbState } from "../../components/Orb";
import { speak, stopSpeaking } from "../../lib/voice";
import { startVoice, type VoiceSession } from "../../lib/voiceClient";
import { diagnose, requestMic, type VoiceDiagnostics } from "../../lib/voiceDiagnostics";
import { reasonFor, type VoiceCode } from "../../lib/voiceReasons";

export function VoiceSection({ hotkey }: { hotkey: string }) {
  const [diag, setDiag] = useState<VoiceDiagnostics | null>(null);
  const [asking, setAsking] = useState(false);
  const [orb, setOrb] = useState<OrbState>("idle");
  const [line, setLine] = useState("");
  const session = useRef<VoiceSession | null>(null);
  const markUrl = browser.runtime.getURL("/glance-mark.png");

  const refresh = useCallback(async () => {
    const d = await diagnose();
    setDiag(d);
    if (import.meta.env.DEV) console.info(`[glance] voice diagnostics in ${d.browser.name} ${d.browser.version}`, d);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = async () => {
    setAsking(true);
    await requestMic();
    setAsking(false);
    await refresh();
  };

  const reason = (code: VoiceCode) => (diag ? reasonFor(code, diag.browser) : code);

  const testListen = () => {
    if (session.current) return session.current.stop();
    let heard = "";
    let failed = false;
    setOrb("listening");
    setLine("Listening… say “what's Tesla at”, then click Stop.");
    session.current = startVoice(
      {
        onInterim: (t) => setLine(`“${t}”`),
        onFinal: (t) => {
          heard = t;
        },
        onError: (code) => {
          failed = true;
          setLine(reason(code));
        },
        onEnd: () => {
          session.current = null;
          setOrb("idle");
          if (!failed) setLine(heard ? `Heard “${heard}”. Voice works.` : reason("no-speech"));
        },
      },
      { via: "offscreen" },
    );
  };

  const testSpeak = () => {
    stopSpeaking();
    const text = "Tesla is at two hundred and fifty dollars. Confirm?";
    setLine(`Saying “${text}”`);
    void speak(text, true, { onStart: () => setOrb("speaking"), onEnd: () => setOrb("idle") }).then(() => {
      setLine((l) => (l.startsWith("Saying") && diag?.voices === 0 ? "No speech voices are installed, so replies are shown, not spoken." : l));
    });
  };

  const granted = diag?.micPermission === "granted";
  const blocked = diag?.micPermission === "denied";
  const status = !diag
    ? ""
    : !diag.recognition
      ? reason("no-recognition")
      : blocked
        ? reason("mic-denied")
        : diag.micDevice === false
          ? reason("no-mic")
          : granted
            ? `Voice is on. Hold ⌥ ${hotkey || "G"} or click the orb's mic to talk.`
            : "Click “Enable voice” once. Your browser will ask to let Glance use your microphone.";

  return (
    <section className="g-card" aria-labelledby="voice">
      <div className="g-section">
        <h2 id="voice" className="g-ui">
          Voice
        </h2>
        <div className="g-row" style={{ gap: 12 }}>
          <button className="g-btn g-btn-primary" onClick={() => void enable()} disabled={asking || granted || !diag?.recognition}>
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
            <dt>Speech recognition</dt>
            <dd>{diag.recognition ? "available" : "missing in this build"}</dd>
            <dt>Speech output</dt>
            <dd>{diag.synthesis ? "available" : "missing"}</dd>
            <dt>Voices installed</dt>
            <dd>{diag.voices > 0 ? diag.voices : "none (replies are shown, not spoken)"}</dd>
            <dt>Microphone permission</dt>
            <dd>{{ granted: "granted to Glance", prompt: "not asked yet", denied: "blocked", unknown: "unknown" }[diag.micPermission]}</dd>
            <dt>Microphone device</dt>
            <dd>{diag.micDevice === null ? "unknown" : diag.micDevice ? "found" : "none found"}</dd>
          </dl>
          <div className="g-row" style={{ gap: 8 }}>
            <button className="g-btn" onClick={testListen} disabled={!granted}>
              {orb === "listening" ? "Stop" : "Test listening"}
            </button>
            <button className="g-btn" onClick={testSpeak} disabled={!diag.synthesis}>
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
