/**
 * Background service worker: the only part of Glance that talks to the API, and the owner of the side panel.
 * It never holds a key and never signs: trades are signed by the API's agent key, which the vault bounds on chain.
 */
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import type { ApiRequest, ApiResponse, Message } from "../lib/messages";
import { apiBaseUrl, vaultAddress } from "../lib/settings";

const READ_TIMEOUT_MS = 15_000;
const TRADE_TIMEOUT_MS = 90_000; // a trade waits for its receipt

/** Every open tab polls /health; the API rate-limits per IP. Cache the slow-moving reads briefly. */
const CACHE_TTL_MS: Record<string, number> = { "/health": 20_000, "/catalog": 300_000 };
const cache = new Map<string, { at: number; base: string; reply: ApiResponse<unknown> }>();

/** Windows whose side panel is open (the panel connects a port named sidepanel:<windowId>). */
const openPanels = new Set<number>();

async function callApi(req: ApiRequest): Promise<ApiResponse<unknown>> {
  const base = (await apiBaseUrl.getValue()).replace(/\/+$/, "");
  const ttl = req.method === "GET" ? CACHE_TTL_MS[req.path] : undefined;
  if (ttl) {
    const hit = cache.get(req.path);
    if (hit && hit.base === base && Date.now() - hit.at < ttl) return hit.reply;
    const reply = await fetchApi(base, req);
    if (reply.ok) cache.set(req.path, { at: Date.now(), base, reply });
    return reply;
  }
  return fetchApi(base, req);
}

async function fetchApi(base: string, req: ApiRequest): Promise<ApiResponse<unknown>> {
  const timeout = req.path.startsWith("/trade") ? TRADE_TIMEOUT_MS : READ_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(`${base}${req.path}`, {
      method: req.method,
      headers: req.body === undefined ? undefined : { "content-type": "application/json" },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    return {
      ok: false,
      status: 0,
      offline: true,
      code: timedOut ? "TIMEOUT" : "API_OFFLINE",
      message: timedOut ? "The Glance API took too long to answer." : `Glance can't reach its API at ${base}.`,
    };
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body: handled below
  }
  if (res.ok) return { ok: true, status: res.status, data };
  const error = (data as { error?: { code?: string; message?: string; guard?: never } } | null)?.error;
  return {
    ok: false,
    status: res.status,
    offline: false,
    code: error?.code ?? `HTTP_${res.status}`,
    message: error?.message ?? `The Glance API answered ${res.status}.`,
    guard: error?.guard,
  };
}

async function broadcastPanel(windowId: number, open: boolean) {
  const tabs = await browser.tabs.query({ windowId });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    browser.tabs.sendMessage(tab.id, { kind: "panel:changed", open }).catch(() => {
      // tabs without our content script (chrome://, the Web Store) simply don't answer
    });
  }
}

export default defineBackground(() => {
  // The toolbar icon opens the docked side panel.
  browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === "install" && !(await vaultAddress.getValue())) await browser.runtime.openOptionsPage();
  });

  browser.runtime.onConnect.addListener((port) => {
    const match = /^sidepanel:(\d+)$/.exec(port.name);
    if (!match) return;
    const windowId = Number(match[1]);
    openPanels.add(windowId);
    void broadcastPanel(windowId, true);
    port.onDisconnect.addListener(() => {
      openPanels.delete(windowId);
      void broadcastPanel(windowId, false);
    });
  });

  browser.runtime.onMessage.addListener((message: Message, sender) => {
    switch (message.kind) {
      case "api":
        return callApi(message);
      case "open:settings":
        return browser.runtime.openOptionsPage().then(() => true);
      case "panel:isOpen":
        return Promise.resolve(sender.tab?.windowId !== undefined && openPanels.has(sender.tab.windowId));
      case "panel:open": {
        const windowId = sender.tab?.windowId;
        if (windowId === undefined || !browser.sidePanel) return Promise.resolve(false);
        // Must run inside the user gesture that sent this message: no awaits before open().
        return browser.sidePanel.open({ windowId }).then(
          () => true,
          () => false,
        );
      }
      default:
        return undefined;
    }
  });
});
