/**
 * Settings. Visible: the vault (or "Set me up"), this browser's link, voice (the microphone, tests, credits), and the
 * keys and sounds. Under a closed "Developer" section: the API and console URLs, a vault typed by hand, the extension
 * ID and CORS hint, a connection test against GET /health, and the raw voice diagnostics.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";

import { Orb } from "../../components/Orb";
import { useVoiceStatus, VoiceDiagnostics, VoiceSection } from "./VoiceSection";
import { openConsolePage } from "../../lib/linking";
import { installPageUrl, latestZipUrl } from "../../lib/getGlance";
import { sidePanelSupported } from "../../lib/sidePanel";
import { api } from "../../lib/api";
import type { Health } from "../../lib/api-types";
import { mountPageStyles } from "../../lib/extensionPage";
import { ageHours } from "../../lib/format";
import { hotkeyError } from "../../lib/hotkeys";
import {
  apiBaseUrl,
  consoleUrl,
  DEFAULT_API_URL,
  DEFAULT_CONSOLE_URL,
  defaultMode,
  hotkeyLetter,
  isAddress,
  soundsEnabled,
  vaultAddress,
  voiceKeyLetter,
  voiceReplies,
  devTools,
  vaultSource,
  type Mode,
  type VaultSource,
} from "../../lib/settings";
import { sound } from "../../lib/tokens";
import { BrowserLink, vaultSourceLine } from "../../components/BrowserLink";

type Test = { state: "idle" } | { state: "running" } | { state: "ok"; health: Health } | { state: "failed"; message: string };


function isLocal(url: string) {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Developer tools: saved at once. With it on, typing "glance test drawing" in the panel draws every Show me shape. */
function DevToggle() {
  const [on, setOn] = useState(false);
  useEffect(() => void devTools.getValue().then(setOn), []);
  return (
    <label className="g-row g-meta" style={{ gap: 8 }}>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked);
          void devTools.setValue(e.target.checked);
        }}
      />{" "}
      Developer tools (type “glance test drawing” in the panel to draw every Show me shape on your selection)
    </label>
  );
}

function Settings() {
  const [form, setForm] = useState({ api: DEFAULT_API_URL, vault: "", hotkey: "G", voiceKey: "V", mode: "floating" as Mode, console: "", voice: true, sounds: sound.enabledByDefault as boolean });
  const [saved, setSaved] = useState<string>("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [test, setTest] = useState<Test>({ state: "idle" });
  const [source, setSource] = useState<VaultSource | null>(null);
  const [loadedVault, setLoadedVault] = useState<string>("");
  const loadedRef = useRef("");
  // A browser with no side panel (Arc) can't dock: the option says so instead of looking broken.
  const canDock = sidePanelSupported(browser.sidePanel);

  // The console's handshake can set the vault while this page is open: show it (unless it's being edited here).
  useEffect(() => {
    void vaultSource.getValue().then(setSource);
    const a = vaultSource.watch((v) => setSource(v));
    const b = vaultAddress.watch((v) => {
      setLoadedVault(v);
      setForm((f) => (f.vault === loadedRef.current ? { ...f, vault: v } : f));
      loadedRef.current = v;
    });
    return () => {
      a();
      b();
    };
  }, []);

  useEffect(() => {
    void Promise.all([apiBaseUrl.getValue(), vaultAddress.getValue(), hotkeyLetter.getValue(), voiceKeyLetter.getValue(), defaultMode.getValue(), consoleUrl.getValue(), voiceReplies.getValue(), soundsEnabled.getValue()]).then(
      ([api, vault, hotkey, voiceKey, mode, console, voice, sounds]) => {
        setForm({ api, vault, hotkey, voiceKey, mode, console, voice, sounds });
        setLoadedVault(vault);
        loadedRef.current = vault;
      },
    );
  }, []);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved("");
  };

  const save = async () => {
    const e: Record<string, string> = {};
    try {
      const u = new URL(form.api);
      if (!/^https?:$/.test(u.protocol)) e.api = "Use an http:// or https:// address.";
    } catch {
      e.api = "That isn't a URL.";
    }
    if (form.vault && !isAddress(form.vault)) e.vault = "A vault address is 0x followed by 40 hex characters.";
    const keyErrors = hotkeyError(form.hotkey, form.voiceKey);
    if (keyErrors.glance) e.hotkey = keyErrors.glance;
    if (keyErrors.voice) e.voiceKey = keyErrors.voice;
    try {
      new URL(form.console);
    } catch {
      e.console = "That isn't a URL.";
    }
    setErrors(e);
    if (Object.keys(e).length) return;

    // A non-local API needs host permission, granted by the user once.
    if (!isLocal(form.api)) {
      const origin = `${new URL(form.api).origin}/*`;
      const granted = await browser.permissions.request({ origins: [origin] }).catch(() => false);
      if (!granted) {
        setErrors({ api: "Glance needs permission to reach that address. Save again and choose Allow." });
        return;
      }
    }
    // The vault is saved only if it was changed here (by hand, under Developer).
    const vaultChanged = form.vault.trim() !== loadedVault;
    await Promise.all([
      apiBaseUrl.setValue(form.api.replace(/\/+$/, "")),
      ...(vaultChanged ? [vaultAddress.setValue(form.vault.trim()), vaultSource.setValue("manual")] : []),
      hotkeyLetter.setValue(form.hotkey),
      voiceKeyLetter.setValue(form.voiceKey),
      defaultMode.setValue(form.mode),
      consoleUrl.setValue(form.console.replace(/\/+$/, "")),
      voiceReplies.setValue(form.voice),
      soundsEnabled.setValue(form.sounds),
    ]);
    setSaved("Saved.");
    void runTest();
  };

  const runTest = async () => {
    setTest({ state: "running" });
    const res = await api.health();
    setTest(res.ok ? { state: "ok", health: res.data } : { state: "failed", message: res.message });
  };

  const voice = useVoiceStatus();
  const hasVault = isAddress(form.vault);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px 96px", display: "flex", flexDirection: "column", gap: 32 }}>
      <header className="g-row" style={{ gap: 14 }}>
        <Orb state={test.state === "ok" ? "success" : test.state === "running" ? "thinking" : "idle"} size={40} markUrl="/glance-mark.png" />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 className="g-heading">Glance settings</h1>
          <span className="g-meta">Glance holds no wallet and can never withdraw. It signs trade requests with this browser's own key, once your vault's owner links it; every trade stays inside your vault's limits.</span>
        </div>
      </header>

      <section className="g-card" aria-labelledby="vault-h">
        <div className="g-section">
          <h2 id="vault-h" className="g-ui">
            Vault
          </h2>
          {hasVault ? (
            <>
              <span className="g-mono" data-testid="vault-address">
                {form.vault}
              </span>
              <span className="g-meta">{vaultSourceLine(source, form.vault)}</span>
            </>
          ) : (
            <div className="g-row" style={{ gap: 12 }}>
              <span className="g-ui" data-testid="vault-address">
                None yet
              </span>
              <button className="g-btn g-btn-primary" onClick={() => void openConsolePage("start")}>
                Set me up
              </button>
            </div>
          )}
        </div>
        <div className="g-section">
          <BrowserLink vault={form.vault} />
        </div>
      </section>

      <VoiceSection voiceKey={form.voiceKey} status={voice} />

      <section className="g-card" aria-labelledby="talk">
        <div className="g-section">
          <h2 id="talk" className="g-ui">
            Keys and sounds
          </h2>
          <Field label="Glance key (tap)" hint="Tap with Option (Alt on Windows): scan the page and show the companies found. It never listens." error={errors.hotkey}>
            <div className="g-row">
              <span className="g-kbd">⌥ +</span>
              <input className="g-input g-mono" style={{ width: 64 }} maxLength={1} aria-label="Glance key letter" value={form.hotkey} onChange={(e) => set("hotkey", e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
            </div>
          </Field>
          <Field label="Voice key (hold)" hint="Hold with Option (Alt on Windows) to talk, release to send. Option+V is taken in some Mac apps; pick another letter if it clashes." error={errors.voiceKey}>
            <div className="g-row">
              <span className="g-kbd">⌥ +</span>
              <input className="g-input g-mono" style={{ width: 64 }} maxLength={1} aria-label="Voice key letter" value={form.voiceKey} onChange={(e) => set("voiceKey", e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
            </div>
          </Field>
          <Field label="Where Glance lives" hint={canDock ? "Floating orb on every page, or docked in the browser's side panel." : "This browser has no side panel, so Glance stays a floating panel."}>
            <div className="g-chips" role="radiogroup">
              {(["floating", "docked"] as Mode[]).map((m) => (
                <button
                  key={m}
                  className="g-chip"
                  role="radio"
                  aria-checked={form.mode === m}
                  aria-pressed={form.mode === m}
                  disabled={m === "docked" && !canDock}
                  onClick={() => set("mode", m)}
                  style={{ fontFamily: "var(--g-font)" }}
                >
                  {m === "floating" ? "Floating orb" : "Docked side panel"}
                </button>
              ))}
            </div>
          </Field>
          <label className="g-row g-ui" style={{ gap: 8 }}>
            <input type="checkbox" checked={form.voice} onChange={(e) => set("voice", e.target.checked)} /> Speak replies aloud
          </label>
          <label className="g-row g-ui" style={{ gap: 8 }}>
            <input type="checkbox" checked={form.sounds} onChange={(e) => set("sounds", e.target.checked)} /> Sounds (a soft liquid sound when the panel
            opens and closes)
          </label>
        </div>
      </section>

      <div className="g-row">
        <button className="g-btn g-btn-primary" onClick={() => void save()}>
          Save
        </button>
        <span className="g-meta" role="status">
          {saved}
        </span>
      </div>

      <span className="g-meta" data-testid="get-glance">
        Get Glance for another browser:{" "}
        <a href={latestZipUrl(form.console || DEFAULT_CONSOLE_URL)} target="_blank" rel="noreferrer">
          the latest version (zip)
        </a>{" "}
        and{" "}
        <a href={installPageUrl(form.console || DEFAULT_CONSOLE_URL)} target="_blank" rel="noreferrer">
          the install steps
        </a>
        .
      </span>

      {/* Everything a developer needs, closed by default. */}
      <details className="g-card" data-testid="developer">
        <summary className="g-ui" style={{ padding: "var(--g-s5) var(--g-s7)", cursor: "pointer" }}>
          Developer
        </summary>
        <div className="g-section">
          <Field label="API base URL" hint={`Where the Glance API runs. This build's default: ${DEFAULT_API_URL}.`} error={errors.api}>
            <input className="g-input" value={form.api} onChange={(e) => set("api", e.target.value.trim())} spellCheck={false} />
          </Field>
          <Field label="Console URL" hint="Where the owner renews the agent, changes limits and funds the vault." error={errors.console}>
            <input className="g-input" value={form.console} onChange={(e) => set("console", e.target.value.trim())} spellCheck={false} />
          </Field>
          <Field label="Enter a vault address by hand" hint="The console sets this when you connect Glance there; typing one is for developers." error={errors.vault}>
            <input className="g-input g-mono" value={form.vault} placeholder="0x…" onChange={(e) => set("vault", e.target.value.trim())} spellCheck={false} />
          </Field>
          <span className="g-meta">
            Extension ID: <span className="g-mono">{browser.runtime.id}</span>. The API allows it through CORS_ORIGINS (chrome-extension://{browser.runtime.id}).
          </span>
          <div className="g-row">
            <button className="g-btn" onClick={() => void runTest()} disabled={test.state === "running"}>
              {test.state === "running" ? "Testing…" : "Test connection"}
            </button>
          </div>
          {test.state === "failed" && (
            <>
              <span className="g-body">{test.message}</span>
              <span className="g-meta">Start the API with `pnpm --filter api dev`, then test again.</span>
            </>
          )}
        </div>
        {test.state === "ok" && <HealthView health={test.health} />}
        <div className="g-section">
          <VoiceDiagnostics status={voice} />
          <DevToggle />
        </div>
      </details>
    </main>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="g-ui">{label}</span>
      {children}
      {error ? <span className="g-meta" style={{ color: "var(--g-guard)" }}>{error}</span> : hint ? <span className="g-meta">{hint}</span> : null}
    </div>
  );
}

function HealthView({ health }: { health: Health }) {
  return (
    <>
      <div className="g-section">
        <dl className="g-facts">
          <dt>Chain</dt>
          <dd>
            {health.chainId} {health.chainId === health.expectedChainId ? "· Robinhood Chain testnet" : `· expected ${health.expectedChainId}`}
          </dd>
          {health.agent && (
            <>
              <dt>Agent</dt>
              <dd>{health.agent.address.slice(0, 6)}…{health.agent.address.slice(-4)} · key {health.agent.keyLoaded ? "loaded" : "not loaded (trades disabled)"}</dd>
              <dt>Agent ETH balance</dt>
              <dd>{Number(health.agent.ethBalance).toFixed(5)} ETH</dd>
            </>
          )}
        </dl>
      </div>
      {health.feeds && (
        <div className="g-section">
          <span className="g-ui">Price feeds</span>
          <dl className="g-facts">
            {health.feeds.map((f) => (
              <FeedRow key={f.symbol} symbol={f.symbol} value={`$${Number(f.price.value).toFixed(2)} · ${ageHours(f.ageSeconds)} old · ${f.marketState.toLowerCase()} · ${f.source}`} state={f.marketState} />
            ))}
          </dl>
        </div>
      )}
    </>
  );
}

function FeedRow({ symbol, value, state }: { symbol: string; value: string; state: string }) {
  return (
    <>
      <dt className="g-live">
        <span className="g-dot" data-state={state} />
        {symbol}
      </dt>
      <dd>{value}</dd>
    </>
  );
}

mountPageStyles();
createRoot(document.getElementById("root")!).render(
  <div className="g-root" style={{ display: "block", minHeight: "100vh" }}>
    <Settings />
  </div>,
);
