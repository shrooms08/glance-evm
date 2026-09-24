/**
 * Link expiry, in the panel (and a small hint by the orb): from 3 days before this browser's link ends, "Relink" opens
 * the console Dashboard (one signature). And the demo vault's line.
 */
import { DEMO_VAULT_LABEL } from "@glance/core/session";

import type { RelinkHint } from "../lib/handshake";

/** The demo vault's line: open, nothing to link. */
export const DEMO_NO_SETUP = `${DEMO_VAULT_LABEL}, no setup needed.`;

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
