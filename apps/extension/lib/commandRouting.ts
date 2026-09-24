/**
 * The background's two keyboard paths, kept pure so they can be tested:
 *   - a browser command (⌥G "glance" by default; "talk" only if the user assigns it a key) goes to that tab's Glance.
 *     Invoking a command grants activeTab for the tab, which is what lets Show me take a screenshot;
 *   - a Show me screenshot: the visible tab, or null when the browser won't allow it (no activeTab grant and no host
 *     permission), and the answer goes ahead without the image.
 */
import type { CommandMessage } from "./messages";

export function forwardCommand(command: string, tabId: number | undefined, send: (tabId: number, message: CommandMessage) => Promise<unknown>): boolean {
  if ((command !== "glance" && command !== "talk") || tabId === undefined) return false;
  void send(tabId, { kind: "command", command }).catch(() => {});
  return true;
}

export async function captureForShowMe(windowId: number | undefined, capture: (windowId: number) => Promise<string>): Promise<string | null> {
  if (windowId === undefined) return null;
  return capture(windowId).then(
    (url) => url,
    () => null,
  );
}
