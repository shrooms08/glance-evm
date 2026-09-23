"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { getAddress, isAddress, isAddressEqual } from "viem";

import { shortAddress } from "@/lib/format";
import { usePathWithVault, useSelectedVault, useVaultOptions } from "@/lib/vault";

/** The Paxos USDG vault (primary), the TestUSDG vault (fallback), your own vault, or any address you paste. */
export function VaultSwitcher() {
  const selected = useSelectedVault();
  const options = useVaultOptions();
  const to = usePathWithVault();
  const router = useRouter();
  const details = useRef<HTMLDetailsElement>(null);
  const [paste, setPaste] = useState("");
  const current = options.find((o) => isAddressEqual(o.address, selected));
  const close = () => details.current?.removeAttribute("open");

  return (
    <details className="switcher" ref={details}>
      <summary aria-label="Choose a vault">
        <span className="switcher-label">{current?.label ?? "Vault"}</span>
        <span className="mono switcher-address">{shortAddress(selected)}</span>
        <span className="switcher-caret" aria-hidden>▾</span>
      </summary>
      <div className="switcher-menu" role="menu">
        {options.map((o) => (
          <Link key={o.address} href={to(o.address)} className="switcher-item" role="menuitem" aria-current={isAddressEqual(o.address, selected) || undefined} onClick={close}>
            <span className="switcher-item-top">
              <span>{o.label}</span>
              {o.mine && <span className="chip chip-accent">Yours</span>}
            </span>
            <span className="meta">{o.note}</span>
            <span className="mono meta">{o.address}</span>
          </Link>
        ))}
        <form
          className="switcher-paste"
          onSubmit={(e) => {
            e.preventDefault();
            if (!isAddress(paste.trim())) return;
            router.push(to(getAddress(paste.trim())));
            setPaste("");
            close();
          }}
        >
          <label className="meta" htmlFor="vault-paste">
            Any other vault
          </label>
          <div className="row">
            <input id="vault-paste" className="input mono" placeholder="0x…" value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false} autoComplete="off" />
            <button className="btn btn-small" disabled={!isAddress(paste.trim())}>
              Open
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}
