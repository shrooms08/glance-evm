/**
 * Messages between the content script, the side panel, the settings page and the background service worker.
 * Only the background talks to the API: it holds the host permission, so the host page's CORS and CSP never apply.
 */
export type ApiRequest = { kind: "api"; method: "GET" | "POST"; path: string; body?: unknown };

export type ApiResponse<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; offline: boolean; code: string; message: string; guard?: import("./api-types").Guard };

export type PanelMessage =
  | { kind: "panel:open" }
  | { kind: "panel:isOpen" }
  | { kind: "panel:changed"; open: boolean };

export type PageMessage =
  | { kind: "page:matches" }
  /**
   * A glance from the side panel (Option+G, or the panel opening): rescan the page, ask about its unresolved names
   * (the one Claude lookup a glance may make), then reply with what was found.
   */
  | { kind: "page:scan" }
  | { kind: "page:reveal"; symbol: string }
  /** The side panel is placing a buy: what page is it on, and which sentence named the company? (For the journal.) */
  | { kind: "page:context"; symbol: string };

export interface PageMatchesReply {
  host: string;
  companies: Array<{ symbol: string; name: string; mentions: number }>;
}

export type Message = ApiRequest | PanelMessage | PageMessage | { kind: "open:settings" };
