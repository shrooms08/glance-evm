/** The page's side of Show me, streamed (see lib/showStream.ts): one port, the request out, events back. */
import { browser } from "wxt/browser";

import type { ShowMeRequest } from "./api";
import { SHOWME_PORT, type StreamMessage, type StreamSentence } from "./showStream";

export function askStream(body: ShowMeRequest, onSentence: (s: StreamSentence) => void): Promise<{ ok: true; source: string } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    let port: ReturnType<typeof browser.runtime.connect>;
    try {
      port = browser.runtime.connect({ name: SHOWME_PORT });
    } catch {
      return resolve({ ok: false, message: "Glance's background worker didn't answer." });
    }
    let settled = false;
    const settle = (r: { ok: true; source: string } | { ok: false; message: string }) => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch {
        // already closed
      }
      resolve(r);
    };
    port.onMessage.addListener((m: StreamMessage) => {
      if (m.event === "sentence") onSentence(m.data);
      else if (m.event === "done") settle({ ok: true, source: m.data.source });
      else if (m.event === "error") settle({ ok: false, message: m.data.message });
    });
    port.onDisconnect.addListener(() => settle({ ok: false, message: "Glance's background worker stopped." }));
    port.postMessage(body);
  });
}
