/**
 * Settings' "This browser" section and the vault's source line. The vault is set by the console's handshake; "Link
 * Glance" opens the console's Dashboard (one signature there).
 */
import { useEffect, useState } from "react";

import { forgetThisBrowser, linkedUntil, linkStatus, sessionInfo, startLinking, waitForLink } from "../lib/linking";
import { isAddress, type VaultSource } from "../lib/settings";

/** Where the vault came from, in a line. */
export function vaultSourceLine(source: VaultSource | null, vault: string): string {
  if (source === "console") return "Set by the console when you connected Glance to your vault.";
  if (source === "manual") return "Entered by hand (Developer).";
  return isAddress(vault) ? "Entered by hand (Developer)." : "Not set up yet: Set me up opens the console's Get started.";
}

type LinkView = { state: "checking" } | { state: "linked"; until: number } | { state: "not-linked"; reason: string } | { state: "waiting" } | { state: "unreachable" };

/**
 * "This browser": its session address, whether the vault's owner has linked it (and until when), a button that opens
 * the console to link it, and "Unlink this browser" (forgets its key; the owner can also unlink it from the console).
 */
export function BrowserLink({ vault }: { vault: string }) {
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

  const status = view.state === "linked" ? "Linked" : view.state === "checking" ? "Checking…" : view.state === "waiting" ? "Waiting…" : view.state === "unreachable" ? "Unknown" : "Not linked";
  return (
    // A column of its own (it isn't inside a Field): the title, its status and the line never run together.
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="g-row" style={{ gap: 8 }}>
        <span className="g-ui">This browser</span>{" "}
        <span className="g-chip" data-testid="link-status" data-linked={view.state === "linked" || undefined}>
          {status}
        </span>{" "}
      </div>
      <span className="g-meta">
        {view.state === "linked"
          ? `${linkedUntil(view.until)}. It may ask Glance to trade this vault within its limits. It can never withdraw.`
          : view.state === "waiting"
            ? "Waiting for your signature on the console's Dashboard…"
            : view.state === "unreachable"
              ? "Can't reach the Glance API to check this browser's link."
              : view.state === "checking"
                ? "Checking…"
                : view.reason === "expired"
                  ? "This browser's link has expired. Link it again."
                  : "Not linked. Link Glance opens your console's Dashboard: one signature from your vault's owner (not a transaction)."}
      </span>
      {address && (
        <span className="g-meta">
          Session <span className="g-mono">{address.slice(0, 6)}…{address.slice(-4)}</span> (only this address leaves the extension; its key never does)
        </span>
      )}
      <div className="g-row">
        <button className="g-btn g-btn-primary" onClick={() => void link()} disabled={!valid || view.state === "waiting"}>
          {view.state === "linked" ? "Relink" : "Link Glance"}
        </button>
        <button className="g-btn g-btn-ghost" onClick={() => void unlink()} disabled={view.state === "waiting"}>
          Unlink this browser
        </button>
      </div>
    </div>
  );
}

