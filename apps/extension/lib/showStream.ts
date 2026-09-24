/**
 * Show me, streamed: the page asks through a runtime port ("showme:stream"), the background reads the API's
 * Server-Sent Events (POST /showme/stream) and passes each event on as it arrives, so the first sentence can be
 * spoken while Claude is still writing the rest. The port closing aborts the request.
 */
import type { ShowAction } from "@glance/core/showme";
import type { ChartRange } from "@glance/core/chart";

import type { ShowMeRequest } from "./api";

export const SHOWME_PORT = "showme:stream";

export interface StreamSentence {
  i: number;
  spoken: string;
  actions: ShowAction[];
  chart?: { symbol: string; range: ChartRange };
}

export type StreamMessage =
  | { event: "sentence"; data: StreamSentence }
  | { event: "done"; data: { source: string } }
  | { event: "error"; data: { message: string } };

/** Parses Server-Sent Events from text chunks: returns complete events and keeps the rest for the next chunk. */
export function parseSse(buffer: string): { events: Array<{ event: string; data: string }>; rest: string } {
  const events: Array<{ event: string; data: string }> = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

/** The background's side: fetches the stream and relays its events over the port. */
export async function relayShowMe(base: string, body: ShowMeRequest, post: (m: StreamMessage) => void, signal: AbortSignal): Promise<void> {
  try {
    const res = await fetch(`${base}/showme/stream`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) {
      const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      return post({ event: "error", data: { message: err?.error?.message ?? `The Glance API answered ${res.status}.` } });
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const parsed = parseSse(buffer + value);
      buffer = parsed.rest;
      for (const e of parsed.events) post({ event: e.event, data: JSON.parse(e.data) } as StreamMessage);
    }
  } catch {
    if (!signal.aborted) post({ event: "error", data: { message: "Glance can't reach its API right now." } });
  }
}
