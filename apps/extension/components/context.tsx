/**
 * Shared state for every Glance surface (in-page UI, side panel): settings, the catalog, API health, the configured
 * vault, and the orb's state line. Each surface runs its own provider.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { browser } from "wxt/browser";

import { api } from "../lib/api";
import { chainStatus, onChainStatus } from "../lib/chainStatus";
import { safely, send } from "../lib/lifecycle";
import type { CatalogStock, Health, Vault } from "../lib/api-types";
import { apiBaseUrl, consoleUrl, defaultMode, hotkeyLetter, soundsEnabled, vaultAddress, vaultSource, voiceKeyLetter, voiceReplies, type Mode, type VaultSource } from "../lib/settings";
import { relinkHint, type RelinkHint } from "../lib/handshake";
import { lostAction, readiness, setupComplete, setupProgress, type Readiness, type SetupProgress } from "../lib/readiness";
import type { Shortcuts } from "../lib/messages";
import { openConsolePage } from "../lib/linking";
import { sessionLink } from "../lib/session";
import { motion, sound } from "../lib/tokens";
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
  /** Option+<glanceKey>, tapped: scan the page and show what was found. */
  glanceKey: string;
  /** Option+<voiceKey>, held: talk. */
  voiceKey: string;
  mode: Mode;
  voiceReplies: boolean;
  /** The open and close sounds (Settings → "Sounds"). */
  sounds: boolean;
  catalog: CatalogStock[];
  health: Health | null;
  vault: Vault | null;
  /** The API could not be reached on the last attempt. */
  offline: boolean;
  offlineMessage: string;
  /** The API is up but the testnet RPC isn't answering it: reads retry, and this clears on its own when it recovers. */
  chainTrouble: boolean;
  usdgDecimals: number;
  markUrl: string;
  orb: OrbLine;
  /** Something that must feel still and certain is on screen (a confirm card): no idle motion. */
  still: boolean;
  /** Hold the orb still until the returned function is called. */
  holdStill(): () => void;
  setOrb(next: Partial<OrbLine> & { state: OrbState }): void;
  refreshVault(): Promise<void>;
  openSettings(): void;
  /** Opens a console page in a new tab ("" for the Dashboard, "/start" for Get started). */
  openConsole(path?: string): void;
  vaultSource: VaultSource | null;
  /** The keyboard shortcuts as the browser has them now (browser commands), or null until known. */
  shortcuts: Shortcuts | null;
  /** From 3 days before this browser's link ends: "Relink" on the orb and in the panel. */
  relink: RelinkHint;
  /**
   * The gate: until Glance has been ready once (your own vault, this browser linked, USDG in the vault), only the setup
   * card shows. Null while that's still being read.
   */
  gated: boolean | null;
  ready: boolean;
  readiness: Readiness;
  setupProgress: SetupProgress | null;
  /** Set up once, then lost: the one thing to do (Relink, Add USDG). */
  lost: "set-up" | "relink" | "add-usdg" | null;
  openAddUsdg(): void;
  /** Opens the console: Get started, or the Dashboard's link card for this vault (one signature there). */
  openSetup(): void;
  openRelink(): void;
}

const Ctx = createContext<Glance | null>(null);
/** Tests only: provide a Glance state directly. */
export const GlanceContextForTests = Ctx;

export function useGlance(): Glance {
  const g = useContext(Ctx);
  if (!g) throw new Error("useGlance outside GlanceProvider");
  return g;
}

function useSetting<T>(item: { getValue(): Promise<T>; watch(cb: (v: T) => void): () => void }, fallback: T): T {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    let live = true;
    void safely(() => item.getValue(), Promise.resolve(fallback)).then((v) => live && setValue(v));
    const unwatch = safely(() => item.watch((v) => setValue(v)), () => {});
    return () => {
      live = false;
      safely(unwatch, undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);
  return value;
}

const HEALTH_POLL_MS = 60_000;
/** How long to wait between checks while the testnet isn't answering (each check retries on its own first). */
export const CHAIN_RECOVERY_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000];

export function GlanceProvider({ children, idleLine }: { children: ReactNode; idleLine: string }) {
  const apiUrl = useSetting(apiBaseUrl, "");
  const vaultAddr = useSetting(vaultAddress, "");
  const consoleLink = useSetting(consoleUrl, "");
  const glanceKey = useSetting(hotkeyLetter, "G");
  const voiceKey = useSetting(voiceKeyLetter, "V");
  const mode = useSetting<Mode>(defaultMode, "floating");
  const voice = useSetting(voiceReplies, true);
  const sounds = useSetting(soundsEnabled, sound.enabledByDefault);
  const source = useSetting<VaultSource | null | undefined>(vaultSource as never, undefined);
  const [shortcuts, setShortcuts] = useState<Shortcuts | null>(null);
  useEffect(() => void send<Shortcuts | undefined>({ kind: "commands:get" }).then((s) => setShortcuts(s ?? null), () => {}), []);
  const link = useSetting(sessionLink, null);
  const complete = useSetting<boolean | undefined>(setupComplete as never, undefined);
  const progress = useSetting<SetupProgress | null>(setupProgress as never, null);
  // The API's word on this browser's link (null while unknown): checked on load, whenever the link changes, and every minute.
  const [linkConfirmed, setLinkConfirmed] = useState<boolean | null>(null);

  const [catalog, setCatalog] = useState<CatalogStock[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [vault, setVault] = useState<Vault | null>(null);
  const [offline, setOffline] = useState(false);
  const [offlineMessage, setOfflineMessage] = useState("");
  const [chainTrouble, setChainTrouble] = useState(chainStatus() === "trouble");
  useEffect(() => onChainStatus((st) => setChainTrouble(st === "trouble")), []);
  const [orb, setOrbState] = useState<OrbLine>({ state: "idle", line: idleLine, meta: "" });
  const successTimer = useRef<ReturnType<typeof setTimeout>>();
  const [stillCount, setStillCount] = useState(0);
  const holdStill = useCallback(() => {
    setStillCount((n) => n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setStillCount((n) => n - 1);
    };
  }, []);

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

  // While the testnet isn't answering: check again with backoff until it does, then refresh what the panel shows.
  useEffect(() => {
    if (!chainTrouble || !apiUrl) return;
    let live = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      const wait = CHAIN_RECOVERY_BACKOFF_MS[Math.min(attempt++, CHAIN_RECOVERY_BACKOFF_MS.length - 1)]!;
      timer = setTimeout(async () => {
        const h = await api.health();
        if (!live) return;
        if (h.ok) {
          setHealth(h.data); // the store has flipped back to ok; the vault refreshes from this
          setOffline(false);
        } else next();
      }, wait);
    };
    next();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [chainTrouble, apiUrl]);

  // Is this browser's link still good? The handshake stored it; the API has the last word (it may have been unlinked).
  useEffect(() => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(vaultAddr) || !link) {
      setLinkConfirmed(null);
      return;
    }
    let live = true;
    const check = async () => {
      const session = await send<{ address: string } | undefined>({ kind: "session:info" }).catch(() => undefined);
      if (!session) return;
      const res = await api.sessionStatus(vaultAddr, session.address);
      if (live && res.ok) setLinkConfirmed(res.data.linked);
    };
    void check();
    const t = setInterval(() => void check(), 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [vaultAddr, link]);

  const ready = readiness({ vault: vaultAddr, link, linkConfirmed, usdgRaw: vault?.balances.usdg.raw ?? null, now: Math.floor(Date.now() / 1000) });
  // The first time everything holds, the gate opens for good (the welcome and tour start then).
  useEffect(() => {
    if (ready.ready && complete === false) void safely(() => setupComplete.setValue(true), Promise.resolve());
  }, [ready.ready, complete]);
  // While gated, look again every 10 seconds, so the card flips to ready by itself as the console finishes.
  useEffect(() => {
    if (complete !== false) return;
    const t = setInterval(() => void refreshVault(), 10_000);
    return () => clearInterval(t);
  }, [complete, refreshVault]);
  const gated = complete === undefined ? null : !complete && !ready.ready;
  // Lost after setup: said only once the facts are in (no banner while the vault or the link check is still loading).
  const factsIn = !ready.steps.vault || (vault !== null && (link === null || linkConfirmed !== null));
  const lost = complete && factsIn ? lostAction(ready) : null;

  const value = useMemo<Glance>(
    () => ({
      apiUrl,
      vaultAddress: vaultAddr,
      consoleUrl: consoleLink,
      glanceKey,
      voiceKey,
      mode,
      voiceReplies: voice,
      sounds,
      catalog,
      health,
      vault,
      offline,
      offlineMessage,
      chainTrouble,
      usdgDecimals: 6,
      markUrl: safely(() => browser.runtime.getURL("/glance-mark.png"), ""),
      orb,
      still: stillCount > 0,
      holdStill,
      setOrb,
      refreshVault,
      openSettings: () => void send({ kind: "open:settings" }).catch(() => {}),
      openConsole: (path = "") => window.open(`${consoleLink.replace(/\/+$/, "")}${path}`, "_blank", "noopener"),
      vaultSource: source ?? null,
      shortcuts,
      relink: relinkHint(link, vaultAddr, Math.floor(Date.now() / 1000)),
      openSetup: () => void openConsolePage("start"),
      openRelink: () => void openConsolePage("link", vaultAddr),
      gated,
      ready: ready.ready,
      readiness: ready,
      setupProgress: progress,
      lost,
      openAddUsdg: () => void openConsolePage("start"),
    }),
    [apiUrl, vaultAddr, consoleLink, glanceKey, voiceKey, mode, voice, sounds, catalog, health, vault, offline, offlineMessage, chainTrouble, orb, stillCount, holdStill, setOrb, refreshVault, source, link, shortcuts, gated, ready, progress, lost],
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
