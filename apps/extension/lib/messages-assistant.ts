import type { VoiceCode } from "./voiceReasons";

/** In docked mode the page handles the hotkeys and hands the results to the side panel, which runs the assistant. */
export type AssistantMessage =
  | { kind: "assistant:listening"; listening: boolean }
  | { kind: "assistant:heard"; text: string }
  | { kind: "assistant:run"; text: string }
  | { kind: "assistant:error"; code: VoiceCode }
  /** Option+G pressed on the page while docked: the page was rescanned; the side panel shows what was found. */
  | { kind: "assistant:glance"; reply: import("./messages").PageMatchesReply };
