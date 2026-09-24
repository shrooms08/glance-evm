/**
 * Settings: API base URL, vault address, the glance and voice keys, floating or docked default, console URL, voice replies, sounds, the
 * "Enable voice" microphone grant with voice diagnostics, and a connection test against GET /health.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";

import { Orb } from "../../components/Orb";
import { VoiceSection } from "./VoiceSection";
import { api } from "../../lib/api";
import type { Health } from "../../lib/api-types";
import { mountPageStyles } from "../../lib/extensionPage";
import { ageHours } from "../../lib/format";
import { hotkeyError } from "../../lib/hotkeys";
import {
  apiBaseUrl,
  consoleUrl,
  DEFAULT_API_URL,
  DEFAULT_VAULT,
  DEMO_VAULTS,
  defaultMode,
  hotkeyLetter,
  isAddress,
  soundsEnabled,
  vaultAddress,
  voiceKeyLetter,
  voiceReplies,
  devTools,
  type Mode,
} from "../../lib/settings";
import { sound } from "../../lib/tokens";
import { DEMO_VAULT_LABEL, forgetThisBrowser, isOpenDemoVault, linkedUntil, linkStatus, sessionInfo, startLinking, waitForLink } from "../../lib/linking";

type Test = { state: "idle" } | { state: "running" } | { state: "ok"; health: Health } | { state: "failed"; message: string };

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.toLowerCase();

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

type LinkView = { state: "checking" } | { state: "linked"; until: number } | { state: "not-linked"; reason: string } | { state: "waiting" } | { state: "unreachable" };

/**
 * "This browser": its session address, whether the vault's owner has linked it (and until when), a button that opens
 * the console to link it, and "Unlink this browser" (forgets its key; the owner can also unlink it from the console).
 * The demo vault needs no link: it's open for trying Glance.
 */
function BrowserLink({ vault }: { vault: string }) {
  const [address, setAddress] = useState<string | null>(null);
  const [view, setView] = useState<LinkView>({ state: "checking" });
  const valid = isAddress(vault);

  useEffect(() => {
    let live = true;
    void (async () => {
      const a = await sessionInfo();
      if (!live) return;
      setAddress(a);
      if (!a || !valid) return setView({ state: "not-linked", reason: "unknown" });
      const s = await linkStatus(vault, a);
      if (!live) return;
      setView(s.linked ? { state: "linked", until: s.expiresAt } : s.reason === "unreachable" ? { state: "unreachable" } : { state: "not-linked", reason: s.reason });
    })();
    return () => {
      live = false;
    };
  }, [vault, valid]);

  const link = async () => {
    setView({ state: "waiting" });
    const started = await startLinking(vault);
    if (!started) return setView({ state: "not-linked", reason: "unknown" });
    setAddress(started.address);
    const s = await waitForLink(vault, started.address);
    setView(s.linked ? { state: "linked", until: s.expiresAt } : { state: "not-linked", reason: s.reason });
  };

  const unlink = async () => {
    await forgetThisBrowser();
    setAddress(await sessionInfo());
    setView({ state: "not-linked", reason: "unknown" });
  };

  return (
    <div className="g-field">
      <span className="g-ui">This browser</span>
      {isOpenDemoVault(vault) && <span className="g-meta">{DEMO_VAULT_LABEL}. Linking is optional here.</span>}
      <span className="g-meta">
        {view.state === "linked"
          ? `${linkedUntil(view.until)}. It may ask Glance to trade this vault within its limits. It can never withdraw.`
          : view.state === "waiting"
            ? "Waiting for your vault owner's signature in the console tab…"
            : view.state === "unreachable"
              ? "Can't reach the Glance API to check this browser's link."
              : view.state === "checking"
                ? "Checking…"
                : view.reason === "expired"
                  ? "This browser's link has expired. Link it again."
                  : "Not linked. Your vault's owner signs once in the console (a signature, not a transaction)."}
      </span>
      {address && (
        <span className="g-meta">
          Session <span className="g-mono">{address.slice(0, 6)}…{address.slice(-4)}</span> (only this address leaves the extension; its key never does)
        </span>
      )}
      <div className="g-row">
        <button className="g-btn g-btn-primary" onClick={() => void link()} disabled={!valid || view.state === "waiting"}>
          {view.state === "linked" ? "Link again" : "Link this browser to my vault"}
        </button>
        <button className="g-btn g-btn-ghost" onClick={() => void unlink()} disabled={view.state === "waiting"}>
          Unlink this browser
        </button>
      </div>
    </div>
  );
}

function Settings() {
  const [form, setForm] = useState({ api: DEFAULT_API_URL, vault: DEFAULT_VAULT as string, hotkey: "G", voiceKey: "V", mode: "floating" as Mode, console: "", voice: true, sounds: sound.enabledByDefault as boolean });
  const [saved, setSaved] = useState<string>("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [test, setTest] = useState<Test>({ state: "idle" });

  useEffect(() => {
    void Promise.all([apiBaseUrl.getValue(), vaultAddress.getValue(), hotkeyLetter.getValue(), voiceKeyLetter.getValue(), defaultMode.getValue(), consoleUrl.getValue(), voiceReplies.getValue(), soundsEnabled.getValue()]).then(
      ([api, vault, hotkey, voiceKey, mode, console, voice, sounds]) => setForm({ api, vault, hotkey, voiceKey, mode, console, voice, sounds }),
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
    await Promise.all([
      apiBaseUrl.setValue(form.api.replace(/\/+$/, "")),
      vaultAddress.setValue(form.vault.trim()),
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

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px 96px", display: "flex", flexDirection: "column", gap: 32 }}>
      <header className="g-row" style={{ gap: 14 }}>
        <Orb state={test.state === "ok" ? "success" : test.state === "running" ? "thinking" : "idle"} size={40} markUrl="/glance-mark.png" />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 className="g-heading">Glance settings</h1>
          <span className="g-meta">Glance holds no wallet and can never withdraw. It signs trade requests with this browser's own key, once your vault's owner links it; every trade stays inside your vault's limits.</span>
        </div>
      </header>

      <section className="g-card" aria-labelledby="conn">
        <div className="g-section">
          <h2 id="conn" className="g-ui">
            Connection
          </h2>
          <Field label="API base URL" hint="Where the Glance API runs. Default http://localhost:8790." error={errors.api}>
            <input className="g-input" value={form.api} onChange={(e) => set("api", e.target.value.trim())} spellCheck={false} />
          </Field>
          <Field
            label="Vault address"
            hint="The vault the agent trades for. The default is the demo vault on real Paxos USDG. No Paxos USDG? The TestUSDG demo vault works the same, funded from its own on-chain faucet."
            error={errors.vault}
          >
            <input className="g-input g-mono" value={form.vault} placeholder="0x…" onChange={(e) => set("vault", e.target.value.trim())} spellCheck={false} />
            <div className="g-chips" role="group" aria-label="Demo vaults">
              <button className="g-chip" aria-pressed={sameAddress(form.vault, DEMO_VAULTS.paxosUSDG)} onClick={() => set("vault", DEMO_VAULTS.paxosUSDG)} style={{ fontFamily: "var(--g-font)" }}>
                Demo vault · Paxos USDG
              </button>
              <button className="g-chip" aria-pressed={sameAddress(form.vault, DEMO_VAULTS.testUSDG)} onClick={() => set("vault", DEMO_VAULTS.testUSDG)} style={{ fontFamily: "var(--g-font)" }}>
                Demo vault · TestUSDG
              </button>
            </div>
          </Field>
          <BrowserLink vault={form.vault} />
          <div className="g-row">
            <button className="g-btn" onClick={() => void runTest()} disabled={test.state === "running"}>
              {test.state === "running" ? "Testing…" : "Test connection"}
            </button>
            <span className="g-meta">Extension ID: <span className="g-mono">{browser.runtime.id}</span> (add chrome-extension://{browser.runtime.id} to the API's CORS_ORIGINS)</span>
          </div>
        </div>
        {test.state === "failed" && (
          <div className="g-section">
            <span className="g-body">{test.message}</span>
            <span className="g-meta">Start the API with `pnpm --filter api dev`, then test again.</span>
          </div>
        )}
        {test.state === "ok" && <HealthView health={test.health} />}
      </section>

      <section className="g-card" aria-labelledby="talk">
        <div className="g-section">
          <h2 id="talk" className="g-ui">
            Talking to Glance
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
          <Field label="Where Glance lives" hint="Floating orb on every page, or docked in Chrome's side panel.">
            <div className="g-chips" role="radiogroup">
              {(["floating", "docked"] as Mode[]).map((m) => (
                <button key={m} className="g-chip" role="radio" aria-checked={form.mode === m} aria-pressed={form.mode === m} onClick={() => set("mode", m)} style={{ fontFamily: "var(--g-font)" }}>
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
          <DevToggle />
        </div>
      </section>

      <VoiceSection voiceKey={form.voiceKey} />

      <section className="g-card" aria-labelledby="console">
        <div className="g-section">
          <h2 id="console" className="g-ui">
            Console
          </h2>
          <Field label="Console URL" hint="Where the owner renews the agent, changes limits and funds the vault." error={errors.console}>
            <input className="g-input" value={form.console} onChange={(e) => set("console", e.target.value.trim())} spellCheck={false} />
          </Field>
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
