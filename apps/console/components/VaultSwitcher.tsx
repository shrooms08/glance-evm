"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { getAddress, isAddress, isAddressEqual } from "viem";

import { shortAddress } from "@/lib/format";
import { useDevMode, useHref, useMyVaults, usePathWithVault, useSelectedVault, vaultMenu } from "@/lib/vault";

/**
 * The header's vault control, for the connected wallet's own vaults only: "Create your vault" with none, "Your vault
 * 0x…" with one, a menu of just its vaults with two or more. (?dev=1 adds the team's vaults and an address box.)
 */
export function VaultSwitcher() {
  const my = useMyVaults();
  const dev = useDevMode();
  const selected = useSelectedVault();
  const to = usePathWithVault();
  const href = useHref();
  const router = useRouter();
  const details = useRef<HTMLDetailsElement>(null);
  const [paste, setPaste] = useState("");

  if (my.status === "no-wallet" && !dev) return null;
  if (my.status === "none" && !dev) {
    return (
      <Link className="btn btn-small" href={href("/start", null)}>
        Create your vault
      </Link>
    );
  }
  const menu = vaultMenu(my.status === "ready" ? my.vaults : [], dev);
  if (menu.kind === "none") return null;
  if (menu.kind === "single") {
    return (
      <Link className="switcher-single" href={href("/", null)} aria-label={`Your vault ${menu.option.address}`}>
        <span className="switcher-label">Your vault</span>
        <span className="mono switcher-address">{shortAddress(menu.option.address)}</span>
      </Link>
    );
  }

  const current = menu.options.find((o) => selected && isAddressEqual(o.address, selected));
  const close = () => details.current?.removeAttribute("open");
  return (
    <details className="switcher" ref={details}>
      <summary aria-label="Choose a vault">
        <span className="switcher-label">{current?.mine ? "Your vault" : (current?.label ?? "Vault")}</span>
        <span className="mono switcher-address">{selected ? shortAddress(selected) : ""}</span>
        <span className="switcher-caret" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="switcher-menu" role="menu">
        {menu.options.map((o) => (
          <Link
            key={o.address}
            href={to(o.address)}
            className="switcher-item"
            role="menuitem"
            aria-current={(selected && isAddressEqual(o.address, selected)) || undefined}
            onClick={close}
          >
            <span className="switcher-item-top">
              <span>{o.label}</span>
              {o.mine && <span className="chip chip-accent">Yours</span>}
            </span>
            <span className="meta">{o.note}</span>
            <span className="mono meta">{o.address}</span>
          </Link>
        ))}
        {menu.paste && (
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
              Any other vault (dev)
            </label>
            <div className="row">
              <input id="vault-paste" className="input mono" placeholder="0x…" value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false} autoComplete="off" />
              <button className="btn btn-small" disabled={!isAddress(paste.trim())}>
                Open
              </button>
            </div>
          </form>
        )}
      </div>
    </details>
  );
}
