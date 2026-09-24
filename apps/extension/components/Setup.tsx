/**
 * Link expiry, in the panel (and a small hint by the orb): from 3 days before this browser's link ends, "Relink" opens
 * the console Dashboard (one signature).
 */
import type { RelinkHint } from "../lib/handshake";

export function relinkLine(hint: Extract<RelinkHint, { show: true }>): string {
  if (hint.expired) return "Glance's link to your vault has ended.";
  return hint.daysLeft <= 1 ? "Glance's link to your vault ends within a day." : `Glance's link to your vault ends in ${hint.daysLeft} days.`;
}

export function RelinkNotice({ hint, onRelink }: { hint: RelinkHint; onRelink(): void }) {
  if (!hint.show) return null;
  return (
    <div className="g-notice" role="status" style={{ borderTop: "1px solid var(--g-line)" }}>
      <span className="g-meta">{relinkLine(hint)} One signature in the console renews it.</span>
      <button className="g-btn" onClick={onRelink}>
        Relink
      </button>
    </div>
  );
}

/**
 * Until Glance has been set up once: the only thing in the panel. Its rows fill in from the console's handshake (and
 * Glance's own checks with the API), and it flips to ready by itself.
 */
export function SetupCard({ rows, onSetUp }: { rows: Array<{ key: string; label: string; done: boolean }>; onSetUp(): void }) {
  return (
    <div className="g-section" style={{ gap: 10 }} aria-label="Set up Glance">
      <span className="g-ui">Set up Glance to start</span>
      <span className="g-meta">Glance trades from your own vault, on a leash you set. Setting up takes about three minutes: the console does the work, you answer your wallet.</span>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        {rows.map((r) => (
          <li key={r.key} className="g-meta" data-done={r.done || undefined}>
            <span aria-hidden>{r.done ? "✓" : "○"}</span> {r.label}
            <span className="g-sr">{r.done ? " (done)" : " (not yet)"}</span>
          </li>
        ))}
      </ul>
      <button className="g-btn g-btn-primary" onClick={onSetUp} autoFocus>
        Set me up
      </button>
    </div>
  );
}

const LOST: Record<"set-up" | "relink" | "add-usdg", { line: string; action: string }> = {
  "set-up": { line: "Glance has no vault to use right now.", action: "Set me up" },
  relink: { line: "This browser's link to your vault has ended.", action: "Relink" },
  "add-usdg": { line: "Your vault has no USDG left to buy with.", action: "Add USDG" },
};

/** Set up once, then something's missing: one line, one action; everything else stays as it was. */
export function LostBanner({ lost, onAction }: { lost: "set-up" | "relink" | "add-usdg"; onAction(): void }) {
  const l = LOST[lost];
  return (
    <div className="g-notice" role="status" style={{ borderTop: "1px solid var(--g-line)" }}>
      <span className="g-meta">{l.line}</span>
      <button className="g-btn" onClick={onAction}>
        {l.action}
      </button>
    </div>
  );
}
