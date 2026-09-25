/**
 * What the voice key does. Hold-to-talk (the default): down starts listening, up sends. Conversation mode (a setting):
 * a tap starts, the end of your turn sends it (AssemblyAI's end-of-turn, on the API), a second tap sends it now, and
 * the key coming up does nothing. Escape cancels either way.
 */
export function talkKey(edge: "down" | "up", o: { conversation: boolean; listening: boolean }): "start" | "stop" | null {
  if (!o.conversation) return edge === "down" ? "start" : "stop";
  if (edge === "up") return null;
  return o.listening ? "stop" : "start";
}
