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
  /** Whether this browser has a side panel Glance can open (Arc doesn't): the page hides "Dock" without one. */
  | { kind: "panel:supported" }
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
  /** Docked: a Show me / teach question from the side panel, answered on the page (it reads, draws and speaks). */
  | { kind: "page:ask"; question: string; lastGuard?: { code: string; message: string } | null }
  /** The side panel is placing a buy: what page is it on, and which sentence named the company? (For the journal.) */
  | { kind: "page:context"; symbol: string };

export interface PageMatchesReply {
  host: string;
  companies: Array<{ symbol: string; name: string; mentions: number }>;
}

/** Show me: a JPEG of the visible tab (a data URL), for a question about a chart or an image. Never stored. */
export type CaptureRequest = { kind: "capture:tab" };

/** Docked: a Show me drawing for the chart in the side panel. */
export type ChartAnnotateMessage = { kind: "chart:annotate"; annotation: import("@glance/core/showme").ChartAnnotation };

/**
 * This browser's session (the key stays in the background worker): its address; open the console to link it to a vault
 * (the owner signs there); forget it ("Unlink this browser").
 */
export type SessionMessage = { kind: "session:info" } | { kind: "session:link"; vault: string } | { kind: "session:forget" } | { kind: "open:console"; page: ConsolePage; vault?: string };
/** Console pages the extension opens: Get started, or the Dashboard with its "Glance in this browser" card focused. */
export type ConsolePage = "start" | "link";
export interface SessionInfo {
  address: string;
}
export interface SessionLinkStarted {
  address: string;
  expiresAt: number;
  url: string;
}

/** A browser command (keyboard shortcut), forwarded by the background to the active tab. */
export type CommandMessage = { kind: "command"; command: "glance" | "talk" };
/** The shortcuts as the browser has them now ("⌥G"), or "" when the user removed one. */
export interface Shortcuts {
  glance: string;
  talk: string;
}

export type Message = ApiRequest | PanelMessage | PageMessage | CaptureRequest | ChartAnnotateMessage | SessionMessage | CommandMessage | { kind: "commands:get" } | { kind: "tab:active" } | { kind: "open:settings" };
