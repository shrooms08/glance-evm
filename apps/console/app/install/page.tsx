"use client";
/**
 * Get Glance: installing the extension, step by step for Chrome, Brave, Arc and Edge. The page notices the moment Glance
 * is in this browser and moves on: "You're set. Open any news article."
 */
import { useState, useSyncExternalStore } from "react";

import { env } from "@/lib/env";
import { useExtensionInstalled } from "@/lib/extensionPresence";
import { BROWSERS, detectBrowser, installSteps, type BrowserKey } from "@/lib/install";

const noSubscribe = () => () => {};

export default function InstallPage() {
  const installed = useExtensionInstalled();
  // The browser this page is open in (Chrome on the server render), until the reader picks another.
  const detected = useSyncExternalStore(
    noSubscribe,
    () =>
      detectBrowser({
        userAgent: navigator.userAgent,
        brave: (navigator as { brave?: unknown }).brave,
        arcPalette: getComputedStyle(document.documentElement).getPropertyValue("--arc-palette-title").trim(),
      }),
    () => "chrome" as BrowserKey,
  );
  const [chosen, setChosen] = useState<BrowserKey | null>(null);
  return <InstallGuide installed={installed} browser={chosen ?? detected} onBrowser={setChosen} downloadUrl={env.extensionDownloadUrl} />;
}

export function InstallGuide(p: { installed: boolean; browser: BrowserKey; onBrowser(b: BrowserKey): void; downloadUrl: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(text), () => {});
  };
  const steps = installSteps(p.browser, p.downloadUrl);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Get Glance</p>
          <h1 className="title">{p.installed ? "You're set. Open any news article." : "Install Glance in your browser"}</h1>
          <p className="meta">
            {p.installed
              ? "Glance underlines the companies it knows. Hover one for its price and a buy button, or hold ⌥V (Alt+V) and ask."
              : "About a minute. Glance starts on the demo vault, so you can try a buy straight away: no wallet needed."}
          </p>
        </div>
      </div>

      {p.installed ? (
        <section className="card" aria-label="Glance is installed">
          <output className="success">
            <span className="success-mark" aria-hidden>
              ✓
            </span>
            <div>
              <p className="ui">Glance is in this browser.</p>
              <p className="meta">Shortcuts: ⌥G (Alt+G) glances at the page, hold ⌥V (Alt+V) to talk. Change them in your browser&apos;s keyboard shortcuts for extensions.</p>
            </div>
          </output>
        </section>
      ) : (
        <section className="card" aria-label="Install steps">
          <fieldset className="segmented" aria-label="Your browser">
            {(Object.keys(BROWSERS) as BrowserKey[]).map((b) => (
              <label key={b} className="segment">
                <input className="sr" type="radio" name="browser" checked={p.browser === b} onChange={() => p.onBrowser(b)} />
                {BROWSERS[b].name}
              </label>
            ))}
          </fieldset>
          <ol className="steps">
            {steps.map((s, i) => (
              <li key={s.title} className="step">
                <span className="step-n" aria-hidden>
                  {i + 1}
                </span>
                <div className="step-body">
                  <h2 className="heading">{s.title}</h2>
                  {s.detail && <p className="meta">{s.detail}</p>}
                  {i === 0 && p.downloadUrl && (
                    <a className="btn btn-primary" href={p.downloadUrl} download>
                      Download Glance
                    </a>
                  )}
                  {s.copy && (
                    <div className="row">
                      <code className="mono">{s.copy}</code>
                      <button className="btn btn-small" onClick={() => copy(s.copy!)}>
                        {copied === s.copy ? "Copied" : "Copy"}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <p className="meta">This page moves on by itself once Glance is installed (reload this page if you installed it in another window).</p>
        </section>
      )}
    </div>
  );
}
