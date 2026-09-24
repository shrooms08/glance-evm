/**
 * First run, on the page and in the panel:
 *   Welcome     the orb's greeting, once (also said in Glance's pre-recorded voice when voice replies are on)
 *   Tour        three coach marks, skippable, shown once: underlines, hover, hold ⌥V
 *   Checklist   "Getting started": hover a company, ask a question, make a demo buy, create your vault
 *   DemoNotice  on the demo vault: "Demo vault: open for trying Glance" and "Set up my own vault"
 *   EmptyPage   a page with no companies: where to try Glance instead
 * Presentational: the content script decides when each shows.
 */
import { DEMO_VAULT_LABEL } from "@glance/core/session";

import type { ChecklistRow } from "../lib/onboarding";

/** Where a coach mark points: a rectangle on the page (an underline, the orb), in viewport coordinates. */
export interface Anchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

const CARD_W = 280;

/** Places the coach mark next to its anchor, inside the viewport (below it if there's room, else above). */
export function placeCoach(a: Anchor, vw: number, vh: number): { left: number; top: number; below: boolean } {
  const below = a.top + a.height + 150 < vh;
  const left = Math.max(12, Math.min(vw - CARD_W - 12, a.left + a.width / 2 - CARD_W / 2));
  const top = below ? a.top + a.height + 10 : Math.max(12, a.top - 140);
  return { left, top, below };
}

export function Welcome({ line, onTour, onSkip, anchor, reducedMotion }: { line: string; onTour(): void; onSkip(): void; anchor: Anchor; reducedMotion: boolean }) {
  const at = placeCoach(anchor, window.innerWidth, window.innerHeight);
  return (
    <div className="g-card g-coach" role="dialog" aria-label="Welcome to Glance" data-motion={reducedMotion ? "reduce" : undefined} style={{ position: "fixed", left: at.left, top: at.top, width: CARD_W }}>
      <div className="g-section" style={{ gap: 8 }}>
        <span className="g-body">{line}</span>
        <div className="g-row">
          <button className="g-btn g-btn-primary g-grow" onClick={onTour} autoFocus>
            Show me around
          </button>
          <button className="g-btn g-btn-ghost" onClick={onSkip}>
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}

export function Tour({
  step,
  total,
  title,
  anchor,
  onNext,
  onSkip,
  reducedMotion,
}: {
  step: number;
  total: number;
  title: string;
  anchor: Anchor;
  onNext(): void;
  onSkip(): void;
  reducedMotion: boolean;
}) {
  const at = placeCoach(anchor, window.innerWidth, window.innerHeight);
  const last = step === total - 1;
  return (
    <>
      {/* A ring around what the step is about (still, when reduced motion is asked for). */}
      <div
        className="g-coach-ring"
        aria-hidden
        data-motion={reducedMotion ? "reduce" : undefined}
        style={{ position: "fixed", left: anchor.left - 6, top: anchor.top - 6, width: anchor.width + 12, height: anchor.height + 12, pointerEvents: "none" }}
      />
      <div className="g-card g-coach" role="dialog" aria-label={`Tour, step ${step + 1} of ${total}`} data-motion={reducedMotion ? "reduce" : undefined} style={{ position: "fixed", left: at.left, top: at.top, width: CARD_W }}>
        <div className="g-section" style={{ gap: 8 }}>
          <span className="g-meta">
            {step + 1} of {total}
          </span>
          <span className="g-ui">{title}</span>
          <div className="g-row">
            <button className="g-btn g-btn-primary g-grow" onClick={onNext} autoFocus>
              {last ? "Got it" : "Next"}
            </button>
            {!last && (
              <button className="g-btn g-btn-ghost" onClick={onSkip}>
                Skip tour
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export function Checklist({ rows, onDismiss }: { rows: ChecklistRow[]; onDismiss(): void }) {
  const done = rows.filter((r) => r.done).length;
  return (
    <div className="g-section" style={{ gap: 6, borderTop: "1px solid var(--g-line)" }} aria-label="Getting started">
      <div className="g-between">
        <span className="g-ui">Getting started</span>
        <span className="g-meta">
          {done} of {rows.length}
        </span>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        {rows.map((r) => (
          <li key={r.key} className="g-meta" data-done={r.done || undefined}>
            <span aria-hidden>{r.done ? "✓" : "○"}</span> <span style={r.done ? { textDecoration: "line-through" } : undefined}>{r.label}</span>
            <span className="g-sr">{r.done ? " (done)" : ""}</span>
          </li>
        ))}
      </ul>
      <button className="g-btn g-btn-ghost" onClick={onDismiss} style={{ alignSelf: "flex-start" }}>
        {done === rows.length ? "All done: hide this" : "Hide"}
      </button>
    </div>
  );
}

export function DemoNotice({ onSetup }: { onSetup(): void }) {
  return (
    <div className="g-notice" role="status" style={{ borderTop: "1px solid var(--g-line)" }}>
      <span className="g-meta">{DEMO_VAULT_LABEL}. Buys here are real testnet trades, inside the demo vault&apos;s limits.</span>
      <button className="g-btn" onClick={onSetup}>
        Set up my own vault
      </button>
    </div>
  );
}

export const EMPTY_PAGE_LINE = "Nothing to underline here. Try a news article about Tesla, Amazon or AMD.";

export function EmptyPage() {
  return (
    <div className="g-section">
      <span className="g-meta">{EMPTY_PAGE_LINE}</span>
    </div>
  );
}
