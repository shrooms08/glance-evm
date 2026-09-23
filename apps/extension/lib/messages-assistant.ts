import type { PageMatchesReply } from "./messages";

/**
 * Docked mode: the page handles the hotkeys and hands them to the side panel, which runs the assistant. Voice is
 * recorded by the offscreen document either way; the side panel just owns the session.
 */
export type AssistantMessage =
  /** Option+V went down (true) or up (false) on the page. */
  | { kind: "assistant:hold"; down: boolean }
  /** Option+G pressed on the page while docked: the page was rescanned; the side panel shows what was found. */
  | { kind: "assistant:glance"; reply: PageMatchesReply };
