/**
 * Background service worker: the only part of Glance that talks to the API, and the owner of the side panel.
 * It never holds a key and never signs: trades are signed by the API's agent key, which the vault bounds on chain.
 */
import { browser } from "wxt/browser";

import { markMicWorked, onMicFailure } from "../lib/voicePrefs";
import { defineBackground } from "wxt/utils/define-background";

import type { ApiRequest, ApiResponse, Message } from "../lib/messages";
import { apiBaseUrl } from "../lib/settings";
import { forgetSession, linkExpiry, sessionAddress, signTrade, type TradeBody } from "../lib/session";
import { consoleUrl } from "../lib/settings";
import type { SessionInfo, SessionLinkStarted } from "../lib/messages";
import { linkUrl, SESSION_HEADERS } from "@glance/core/session";

/** Opens the console's /link page for this browser's session and the vault (the owner signs there). */
async function startLink(vault: string): Promise<SessionLinkStarted | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(vault)) return null;
  const address = await sessionAddress();
  const expiresAt = linkExpiry();
  const url = linkUrl(await consoleUrl.getValue(), vault as `0x${string}`, address, expiresAt);
  await browser.tabs.create({ url });
  return { address, expiresAt, url };
}
import { relayShowMe, SHOWME_PORT } from "../lib/showStream";
import type { ShowMeRequest } from "../lib/api";
import type { OffscreenRequest, SpeechEvent, VoiceEvent, VoiceRequest } from "../lib/voiceMessages";

const READ_TIMEOUT_MS = 15_000;
const TRADE_TIMEOUT_MS = 90_000; // a trade waits for its receipt

/** Every open tab polls /health; the API rate-limits per IP. Cache the slow-moving reads briefly. */
const CACHE_TTL_MS: Record<string, number> = { "/health": 20_000, "/catalog": 300_000 };
const cache = new Map<string, { at: number; base: string; reply: ApiResponse<unknown> }>();

/** Windows whose side panel is open (the panel connects a port named sidepanel:<windowId>). */
const openPanels = new Set<number>();

function safePost(port: { postMessage(m: unknown): void }, m: unknown) {
  try {
    port.postMessage(m);
  } catch {
    // the page went away
  }
}

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
    // A trade is signed with this browser's session key (lib/session.ts): the API checks it before the agent signs.
    const signed = req.method === "POST" && req.path === "/trade" ? await signTrade(req.body as TradeBody) : null;
    // Every request names this browser's session (its address only), so the API can limit per browser as well as per IP.
    const session = { [SESSION_HEADERS.session]: await sessionAddress() };
    res = await fetch(`${base}${req.path}`, {
      method: req.method,
      headers: req.body === undefined ? session : { "content-type": "application/json", ...session, ...signed?.headers },
      body: req.body === undefined ? undefined : (signed?.raw ?? JSON.stringify(req.body)),
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

/** A reply spoken in parts: each sentence goes to the offscreen document as it's written. */
async function speakPart(req: Extract<VoiceRequest, { kind: "voice:speak-part" | "voice:speak-end" }>, tabId: number | undefined): Promise<boolean> {
  if (tabId !== undefined) speechTabs.set(req.id, tabId);
  try {
    await ensureOffscreen();
  } catch {
    speechTabs.delete(req.id);
    return false;
  }
  const msg: OffscreenRequest =
    req.kind === "voice:speak-part" ? { kind: "offscreen:speak-part", id: req.id, index: req.index, text: req.text, api: await apiBase() } : { kind: "offscreen:speak-end", id: req.id, total: req.total };
  await browser.runtime.sendMessage(msg).catch(() => {});
  return true;
}

function relayVoice(event: VoiceEvent) {
  const tabId = voiceTabs.get(event.session);
  if (event.type === "end") voiceTabs.delete(event.session);
  if (tabId !== undefined) browser.tabs.sendMessage(tabId, event).catch(() => {});
}

function relaySpeech(event: SpeechEvent) {
  const tabId = speechTabs.get(event.id);
  if (event.type === "end" || event.type === "cut" || event.type === "unavailable") speechTabs.delete(event.id);
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
    // Show me, streamed: the page sends the request once; each Server-Sent Event comes back as it arrives.
    if (port.name === SHOWME_PORT) {
      const abort = new AbortController();
      port.onDisconnect.addListener(() => abort.abort());
      port.onMessage.addListener((body: ShowMeRequest) => {
        void (async () => {
          const base = (await apiBaseUrl.getValue()).replace(/\/+$/, "");
          await relayShowMe(base, body, (m) => safePost(port, m), abort.signal, { [SESSION_HEADERS.session]: await sessionAddress() });
          safePost(port, { event: "done", data: { source: "end" } });
        })();
      });
      return;
    }
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
      case "voice:speak-part":
      case "voice:speak-end":
        return speakPart(message, sender.tab?.id);
      case "voice:warm":
        // Only if the offscreen document already exists: warming must never create one (or ask for the mic).
        void (async () => {
          const url = browser.runtime.getURL("/offscreen.html");
          const existing = await browser.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT" as never], documentUrls: [url] });
          if (existing?.length) await browser.runtime.sendMessage({ kind: "offscreen:warm", api: await apiBase() } satisfies OffscreenRequest).catch(() => {});
          else await fetch(`${await apiBase()}/voice/warm`, { method: "POST" }).catch(() => {});
        })();
        return undefined;
      case "voice:mic-failed":
        // What to show for a microphone failure, from what Glance remembers (lib/voicePrefs.ts). The settings page
        // opens by itself at most once per browser session.
        return onMicFailure(message.name).then(async (d) => {
          if (d.openSetup) await browser.tabs.create({ url: browser.runtime.getURL("/options.html#voice") }).catch(() => {});
          return d.code;
        });
      case "voice:mic-worked":
        void markMicWorked().catch(() => {});
        return undefined;
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
      case "capture:tab": {
        // Only for a Show me question about a chart or an image. Needs the page's host permission; without it, the
        // answer goes ahead without a screenshot.
        const windowId = sender.tab?.windowId;
        if (windowId === undefined) return Promise.resolve(null);
        return browser.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 }).then(
          (url) => url,
          () => null,
        );
      }
      case "session:info":
        return sessionAddress().then((address) => ({ address }) satisfies SessionInfo);
      case "session:link":
        return startLink(message.vault);
      case "session:forget":
        return forgetSession().then(() => true);
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
