"use client";
/**
 * Get started, step 5: connect Glance to your vault, right here. Not in this browser yet: how to install it (the page
 * notices by itself when it appears). In it, with a vault: one signature, which also sets the vault Glance uses.
 */
import Link from "next/link";
import { formatExpiry } from "@glance/core/session";
import type { Address } from "viem";

import type { ExtensionState } from "@/lib/glanceExtension";

import { Notice } from "./Notice";

export function GlanceStep(p: {
  ext: ExtensionState["status"];
  vault: Address | null;
  linkedUntil: number | null;
  busy: boolean;
  /** Connected as the owner, on Robinhood Chain testnet. */
  ready: boolean;
  error: string | null;
  onConnect(): void;
}) {
  if (p.ext === "checking") return <p className="meta">Looking for Glance in this browser…</p>;
  if (p.ext === "absent" || p.ext === "outdated") {
    return (
      <p className="meta">
        {p.ext === "outdated" ? "Glance is installed, but it's an older build: rebuild and reload it. " : "Glance isn't in this browser yet. "}
        <Link href="/install">Get Glance</Link> (about a minute). This step finishes itself when it appears.
      </p>
    );
  }
  if (!p.vault) return <p className="meta">Glance is installed. Create your vault first (step 4): it goes straight on to connecting Glance.</p>;
  if (p.linkedUntil) return <p className="meta">Glance uses your vault, linked until {formatExpiry(p.linkedUntil)}. Open any news article.</p>;
  return (
    <>
      <p className="meta">One signature, not a transaction: Glance in this browser uses your vault, and may ask to trade it within its limits. It can never withdraw.</p>
      {p.error && (
        <Notice tone="fail" title="Not connected" role="alert">
          {p.error}
        </Notice>
      )}
      <div className="row">
        <button className="btn btn-primary" onClick={p.onConnect} disabled={p.busy || !p.ready}>
          {p.busy ? "Check your wallet…" : p.error ? "Try again" : "Connect Glance"}
        </button>
      </div>
    </>
  );
}
