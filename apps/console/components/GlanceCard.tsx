"use client";
/**
 * The Dashboard's "Glance in this browser" card: one place to connect the extension to this vault, with no address to
 * paste and no settings to open.
 *   not installed         how to install it (the page keeps checking, and updates when Glance appears)
 *   installed, not linked "Link Glance": one signature (never a transaction), which also sets the extension's vault
 *   linked                "Linked until <date>" and Unlink; from 3 days before the end, Relink
 * A wallet that owns more than one vault is asked which one Glance should use. Linking is the owner's EIP-712 signature,
 * checked by the API against vault.owner() on chain; the extension is told only once the wallet is verified as owner.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isAddressEqual, type Address } from "viem";
import { useSignTypedData } from "wagmi";
import { formatExpiry, ONLY_OWNER } from "@glance/core/session";

import { api } from "@/lib/api";
import { useGlanceExtension, type ExtensionState } from "@/lib/glanceExtension";
import { linkAndTell, RELINK_SOON_SECONDS, unlinkGlance } from "@/lib/linkGlance";
import { shortAddress } from "@/lib/format";
import { reportError } from "@/lib/report";
import { useMyVaults } from "@/lib/vault";

import { Notice } from "./Notice";
import { Skeleton } from "./Skeleton";
import { useGate } from "./useGate";
import { GateNotice, type GateReason } from "./WriteGate";

export type LinkState = { linked: true; expiresAt: number } | { linked: false } | null;

export function GlanceCard({ vault, owner, focus }: { vault: Address; owner: Address; focus?: boolean }) {
  const ext = useGlanceExtension();
  const my = useMyVaults();
  const vaults = my.status === "ready" && my.vaults.length > 0 ? my.vaults.map((v) => v.vault) : [vault];
  const hello = ext.state.status === "present" ? ext.state.hello : null;
  const [chosen, setChosen] = useState<Address>(vault);
  // The vault Glance already uses, when it's one of this wallet's: start from that one.
  useEffect(() => {
    if (hello?.vault && vaults.some((v) => isAddressEqual(v, hello.vault!))) setChosen(hello.vault);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hello?.vault, vaults.length]);

  const gate = useGate(owner);
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ["glance-link", chosen, hello?.sessionAddress],
    queryFn: () => api.sessionStatus(chosen, hello!.sessionAddress),
    enabled: Boolean(hello),
  });
  const link: LinkState = !hello ? null : status.data ? (status.data.linked ? { linked: true, expiresAt: status.data.expiresAt } : { linked: false }) : null;
  const { signTypedDataAsync } = useSignTypedData();
  const [busy, setBusy] = useState<"link" | "unlink" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const sign = (t: Parameters<typeof signTypedDataAsync>[0]) => signTypedDataAsync(t);

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["glance-link"] });
    await client.invalidateQueries({ queryKey: ["linked-browsers"] });
  };

  const onLink = async () => {
    if (!hello || gate.reason !== null) return;
    setProblem(null);
    setBusy("link");
    try {
      // The wallet is this vault's owner (checked here, and by the API on chain): then Glance hears which vault, and that it's linked.
      await linkAndTell({ vault: chosen, session: hello.sessionAddress, sign: sign as never, ownerVerified: gate.reason === null, tell: ext });
      await refresh();
    } catch (err) {
      reportError("Link Glance", err);
      setProblem((err as Error).message.split("\n")[0] ?? "Glance wasn't linked.");
    } finally {
      setBusy(null);
    }
  };

  const onUnlink = async () => {
    if (!hello || gate.reason !== null) return;
    setProblem(null);
    setBusy("unlink");
    try {
      await unlinkGlance({ vault: chosen, session: hello.sessionAddress, sign: sign as never });
      ext.unlinked(chosen);
      await refresh();
    } catch (err) {
      reportError("Unlink Glance", err);
      setProblem((err as Error).message.split("\n")[0] ?? "Glance wasn't unlinked.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <GlanceCardView
      ext={ext.state}
      link={link}
      vaults={vaults}
      chosen={chosen}
      onChoose={setChosen}
      reason={gate.reason}
      busy={busy}
      problem={problem}
      now={Math.floor(Date.now() / 1000)}
      focus={focus}
      onLink={() => void onLink()}
      onUnlink={() => void onUnlink()}
      gateNotice={gate.reason === "no-wallet" || gate.reason === "wrong-network" ? <GateNotice reason={gate.reason} onConnect={gate.onConnect} onSwitchNetwork={gate.onSwitchNetwork} switching={gate.switching} switchError={gate.switchError} /> : null}
    />
  );
}

/** Presentational: every state of the card (each is tested). */
export function GlanceCardView(p: {
  ext: ExtensionState;
  link: LinkState;
  vaults: Address[];
  chosen: Address;
  onChoose(v: Address): void;
  reason: GateReason;
  busy: "link" | "unlink" | null;
  problem: string | null;
  now: number;
  focus?: boolean;
  onLink(): void;
  onUnlink(): void;
  gateNotice?: ReactNode;
}) {
  const section = useRef<HTMLElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  // Opened from Glance ("Link Glance", "Relink"): bring this card into view, its button ready.
  const ready = p.ext.status === "present" && p.link !== null;
  useEffect(() => {
    if (!p.focus || !ready) return;
    section.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    primary.current?.focus();
  }, [p.focus, ready]);

  const hello = p.ext.status === "present" ? p.ext.hello : null;
  const soon = p.link?.linked ? p.link.expiresAt - p.now <= RELINK_SOON_SECONDS : false;
  const off = p.reason !== null || p.busy !== null;

  return (
    <section className="card" aria-labelledby="glance-h" id="glance" ref={section} data-focus={p.focus || undefined}>
      <div className="section-head">
        <p className="eyebrow" id="glance-h">Glance in this browser</p>
      </div>

      {p.ext.status === "checking" && <Skeleton lines={2} />}

      {p.ext.status === "absent" && (
        <>
          <p className="meta">Glance isn&apos;t in this browser yet. Install it, and this card connects it to your vault with one signature: nothing to paste.</p>
          <p className="meta">
            <Link href="/install">Install Glance</Link> · this page notices when it appears.
          </p>
        </>
      )}

      {p.ext.status === "outdated" && (
        <p className="meta">
          Glance is installed, but it&apos;s an older build that can&apos;t connect from here. Rebuild it (<code>pnpm --filter extension build</code>), reload it on your
          browser&apos;s extensions page, then refresh this page.
        </p>
      )}

      {hello && (
        <>
          {p.vaults.length > 1 && (
            <label className="field">
              <span className="meta">Which vault should Glance use?</span>
              <select className="input mono" value={p.chosen} onChange={(e) => p.onChoose(e.target.value as Address)} disabled={p.busy !== null}>
                {p.vaults.map((v) => (
                  <option key={v} value={v}>
                    {shortAddress(v)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {hello.vault && !isAddressEqual(hello.vault, p.chosen) && (
            <p className="meta">
              Glance is using <span className="mono">{shortAddress(hello.vault)}</span> now. Linking switches it to <span className="mono">{shortAddress(p.chosen)}</span>.
            </p>
          )}

          {p.problem && (
            <Notice
              tone="fail"
              title="Not done"
              role="alert"
              action={
                <button className="btn btn-small btn-primary" onClick={p.link?.linked && !soon ? p.onUnlink : p.onLink} disabled={off}>
                  Try again
                </button>
              }
            >
              {p.problem}
            </Notice>
          )}
          {p.reason === "not-owner" && (
            <Notice tone="guard" title={ONLY_OWNER}>
              Connect the wallet that owns this vault to link Glance to it.
            </Notice>
          )}
          {p.gateNotice}

          {p.link === null ? (
            <Skeleton lines={1} />
          ) : p.link.linked ? (
            <>
              <p className="ui">
                Linked until {formatExpiry(p.link.expiresAt)}
                {soon && <span className="chip chip-guard"> ends soon</span>}
              </p>
              <p className="meta">Glance in this browser can ask to trade this vault within its limits. It can never withdraw.</p>
              <div className="row wrap">
                {soon && (
                  <button ref={primary} className="btn btn-primary" onClick={p.onLink} disabled={off}>
                    {p.busy === "link" ? "Check your wallet…" : "Relink"}
                  </button>
                )}
                <button className="btn" onClick={p.onUnlink} disabled={off}>
                  {p.busy === "unlink" ? "Check your wallet…" : "Unlink"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="meta">
                One signature, not a transaction: Glance in this browser may then ask to trade this vault within its limits for 30 days, and it uses this vault from
                now on. It can never withdraw.
              </p>
              <div className="row">
                <button ref={primary} className="btn btn-primary" onClick={p.onLink} disabled={off}>
                  {p.busy === "link" ? "Check your wallet…" : "Link Glance"}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
