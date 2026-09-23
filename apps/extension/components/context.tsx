/**
 * Shared state for every Glance surface (in-page UI, side panel): settings, the catalog, API health, the configured
 * vault, and the orb's state line. Each surface runs its own provider.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { browser } from "wxt/browser";

import { api } from "../lib/api";
import type { CatalogStock, Health, Vault } from "../lib/api-types";
import { apiBaseUrl, consoleUrl, defaultMode, hotkeyLetter, vaultAddress, voiceReplies, type Mode } from "../lib/settings";
import { motion } from "../lib/tokens";
import type { OrbState } from "./Orb";

export interface OrbLine {
  state: OrbState;
  line: string;
  meta: string;
}

export interface Glance {
  apiUrl: string;
  vaultAddress: string;
  consoleUrl: string;
  hotkey: string;
  mode: Mode;
  voiceReplies: boolean;
  catalog: CatalogStock[];
  health: Health | null;
  vault: Vault | null;
  /** The API could not be reached on the last attempt. */
  offline: boolean;
  offlineMessage: string;
  usdgDecimals: number;
  markUrl: string;
  orb: OrbLine;
  setOrb(next: Partial<OrbLine> & { state: OrbState }): void;
  refreshVault(): Promise<void>;
  openSettings(): void;
  openConsole(): void;
}

const Ctx = createContext<Glance | null>(null);

export function useGlance(): Glance {
  const g = useContext(Ctx);
  if (!g) throw new Error("useGlance outside GlanceProvider");
  return g;
}

function useSetting<T>(item: { getValue(): Promise<T>; watch(cb: (v: T) => void): () => void }, fallback: T): T {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    let live = true;
    void item.getValue().then((v) => live && setValue(v));
    const unwatch = item.watch((v) => setValue(v));
    return () => {
      live = false;
      unwatch();
    };
  }, [item]);
  return value;
}

const HEALTH_POLL_MS = 60_000;

export function GlanceProvider({ children, idleLine }: { children: ReactNode; idleLine: string }) {
  const apiUrl = useSetting(apiBaseUrl, "");
  const vaultAddr = useSetting(vaultAddress, "");
  const consoleLink = useSetting(consoleUrl, "");
  const hotkey = useSetting(hotkeyLetter, "G");
  const mode = useSetting<Mode>(defaultMode, "floating");
  const voice = useSetting(voiceReplies, true);

  const [catalog, setCatalog] = useState<CatalogStock[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [vault, setVault] = useState<Vault | null>(null);
  const [offline, setOffline] = useState(false);
  const [offlineMessage, setOfflineMessage] = useState("");
  const [orb, setOrbState] = useState<OrbLine>({ state: "idle", line: idleLine, meta: "" });
  const successTimer = useRef<ReturnType<typeof setTimeout>>();

  const setOrb = useCallback(
    (next: Partial<OrbLine> & { state: OrbState }) => {
      clearTimeout(successTimer.current);
      setOrbState((prev) => ({ line: prev.line, meta: prev.meta, ...next }));
      // Success holds for 2s, then the orb goes back to idle (the line stays readable in the panel).
      if (next.state === "success") {
        successTimer.current = setTimeout(() => setOrbState((prev) => ({ ...prev, state: "idle" })), motion.successHoldMs);
      }
    },
    [],
  );

  const refreshVault = useCallback(async () => {
    if (!vaultAddr) {
      setVault(null);
      return;
    }
    const res = await api.vault(vaultAddr);
    setVault(res.ok ? res.data : null);
  }, [vaultAddr]);

  // Catalog and health: on start, when the API URL changes, and every minute while the page is visible.
  useEffect(() => {
    if (!apiUrl) return;
    let live = true;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      const [c, h] = await Promise.all([catalog.length ? null : api.catalog(), api.health()]);
      if (!live) return;
      if (c?.ok) setCatalog(c.data.stocks);
      if (h.ok) {
        setHealth(h.data);
        setOffline(false);
      } else {
        setOffline(h.offline);
        setOfflineMessage(h.message);
      }
    };
    void load();
    const timer = setInterval(load, HEALTH_POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl]);

  useEffect(() => {
    void refreshVault();
  }, [refreshVault, health]);

  const value = useMemo<Glance>(
    () => ({
      apiUrl,
      vaultAddress: vaultAddr,
      consoleUrl: consoleLink,
      hotkey,
      mode,
      voiceReplies: voice,
      catalog,
      health,
      vault,
      offline,
      offlineMessage,
      usdgDecimals: 6,
      markUrl: browser.runtime.getURL("/glance-mark.png"),
      orb,
      setOrb,
      refreshVault,
      openSettings: () => void browser.runtime.sendMessage({ kind: "open:settings" }).catch(() => {}),
      openConsole: () => window.open(consoleLink, "_blank", "noopener"),
    }),
    [apiUrl, vaultAddr, consoleLink, hotkey, mode, voice, catalog, health, vault, offline, offlineMessage, orb, setOrb, refreshVault],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Every mainnet-mirrored feed reads CLOSED or STALE: the market is shut (weekend, overnight, holiday). */
export function marketClosed(health: Health | null): { closed: boolean; freshestAgeSeconds: number } {
  const feeds = health?.feeds?.filter((f) => f.source === "mainnet-mirror") ?? [];
  if (feeds.length === 0) return { closed: false, freshestAgeSeconds: 0 };
  return {
    closed: feeds.every((f) => f.marketState !== "OPEN"),
    freshestAgeSeconds: Math.min(...feeds.map((f) => f.ageSeconds)),
  };
}
