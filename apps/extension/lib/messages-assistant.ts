/** In docked mode the page captures speech and hands the words to the side panel, which runs the assistant. */
export type AssistantMessage =
  | { kind: "assistant:listening"; listening: boolean }
  | { kind: "assistant:heard"; text: string }
  | { kind: "assistant:run"; text: string };
