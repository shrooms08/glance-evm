/**
 * Background service worker: the only part of Glance that talks to the API, and the owner of the side panel.
 * It never holds a key and never signs: trades are signed by the API's agent key, which the vault bounds on chain.
 */
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import type { ApiRequest, ApiResponse, Message } from "../lib/messages";
import { apiBaseUrl } from "../lib/settings";
import type { OffscreenRequest, SpeechEvent, VoiceEvent, VoiceRequest } from "../lib/voiceMessages";

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

/**
 * Voice: Glance's offscreen document records the audio (its own origin, so the mic permission is Glance's and no
 * website can block it), streams it to the Glance API for transcription, and plays the spoken reply. Each session
 * and each spoken reply remembers the tab that asked, so its events go back to that tab only. Extension pages (side
 * panel, settings) receive the offscreen document's messages directly.
 */
const voiceTabs = new Map<string, number>();
const speechTabs = new Map<string, number>();
let creatingOffscreen: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const url = browser.runtime.getURL("/offscreen.html");
  const offscreen = (browser as unknown as { offscreen?: typeof chrome.offscreen }).offscreen;
  if (!offscreen) throw new Error("no offscreen API");
  const existing = await browser.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT" as never], documentUrls: [url] });
  if (existing && existing.length > 0) return;
  creatingOffscreen ??= offscreen
    .createDocument({
      url,
      reasons: ["USER_MEDIA" as chrome.offscreen.Reason, "AUDIO_PLAYBACK" as chrome.offscreen.Reason],
      justification: "Records push-to-talk audio under Glance's own microphone permission, and plays Glance's spoken replies.",
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

const apiBase = async () => (await apiBaseUrl.getValue()).replace(/\/+$/, "");

async function startVoice(req: Extract<VoiceRequest, { kind: "voice:start" }>, tabId: number | undefined): Promise<boolean> {
  if (tabId !== undefined) voiceTabs.set(req.session, tabId);
  try {
    await ensureOffscreen();
  } catch (err) {
    if (import.meta.env.DEV) console.warn("[glance] offscreen document failed", err);
    voiceTabs.delete(req.session);
    return false;
  }
  // The spoken reply is played under the session's id: route its playback events to the same tab.
  if (tabId !== undefined) speechTabs.set(req.session, tabId);
  const start: OffscreenRequest = { kind: "offscreen:start", session: req.session, lang: req.lang, api: await apiBase(), context: req.context, vault: req.vault };
  await browser.runtime.sendMessage(start).catch(() => {});
  return true;
}

async function speakVoice(req: Extract<VoiceRequest, { kind: "voice:speak" }>, tabId: number | undefined): Promise<boolean> {
  if (tabId !== undefined) speechTabs.set(req.id, tabId);
  try {
    await ensureOffscreen();
  } catch {
    speechTabs.delete(req.id);
    return false;
  }
  await browser.runtime.sendMessage({ kind: "offscreen:speak", id: req.id, text: req.text, api: await apiBase() } satisfies OffscreenRequest).catch(() => {});
  return true;
}

function relayVoice(event: VoiceEvent) {
  const tabId = voiceTabs.get(event.session);
  if (event.type === "end") voiceTabs.delete(event.session);
  if (tabId !== undefined) browser.tabs.sendMessage(tabId, event).catch(() => {});
}

function relaySpeech(event: SpeechEvent) {
  const tabId = speechTabs.get(event.id);
  if (event.type !== "start") speechTabs.delete(event.id);
  if (tabId !== undefined) browser.tabs.sendMessage(tabId, event).catch(() => {});
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
    // First install: open settings (the connection test, the extension ID for CORS, and "Enable voice").
    if (reason === "install") await browser.runtime.openOptionsPage();
  });

  browser.runtime.onConnect.addListener((port) => {
    // Content scripts hold a "glance:content" port only to notice promptly when this extension is reloaded; its
    // disconnect is their signal. Nothing to do here.
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

  browser.runtime.onMessage.addListener((message: Message | VoiceRequest | VoiceEvent | SpeechEvent, sender) => {
    switch (message.kind) {
      case "voice:start":
        return startVoice(message, sender.tab?.id);
      case "voice:speak":
        return speakVoice(message, sender.tab?.id);
      case "voice:hush":
        void browser.runtime.sendMessage({ kind: "offscreen:hush" } satisfies OffscreenRequest).catch(() => {});
        return undefined;
      case "voice:speech":
        relaySpeech(message);
        return undefined;
      case "voice:stop":
      case "voice:abort":
        void browser.runtime
          .sendMessage({ kind: message.kind === "voice:stop" ? "offscreen:stop" : "offscreen:abort", session: message.session } satisfies OffscreenRequest)
          .catch(() => {});
        return undefined;
      case "voice:event":
        relayVoice(message);
        return undefined;
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
