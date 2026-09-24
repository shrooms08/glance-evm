/**
 * Show me, teach and guide, on the page. Only on an explicit request (a held Option+V, or a question typed in the
 * panel). Reads the page (lib/pageRead.ts), adds a screenshot only for a question about a chart or an image, asks the
 * API (POST /showme), then speaks the whole answer as one TTS call and acts on its tags in step with the voice
 * (lib/showScheduler.ts): the orb flies to a quote, circles and underlines are drawn (lib/showDraw.ts), a chart or the
 * portfolio opens. A quote that isn't on the page is skipped silently. Escape (or a new question) cancels it all.
 */
import type { ShowAction } from "@glance/core/showme";

import type { ShowMeReply, ShowMeRequest } from "./api";
import { wantsScreenshot, type PageRead } from "./pageRead";
import { ShowScheduler } from "./showScheduler";

export const SCREENSHOT_MAX_WIDTH = 1_280;

export interface ShowMeDeps {
  readPage(): PageRead;
  surface: "page" | "console";
  /** A JPEG data URL of the visible tab, or null. */
  capture(): Promise<string | null>;
  /** Downscales a data URL to at most SCREENSHOT_MAX_WIDTH wide, as base64 JPEG (no prefix). */
  downscale(dataUrl: string): Promise<string | null>;
  ask(body: ShowMeRequest): Promise<{ ok: true; data: ShowMeReply } | { ok: false; message: string }>;
  /** Speaks the text as one call; progress reports playback time and (once known) duration. */
  speak(text: string, h: { onStart(): void; onProgress(t: number, d: number | null): void; onEnd(): void }): Promise<void>;
  hush(): void;
  findQuote(quote: string): Range | null;
  reveal(range: Range): void;
  draw(kind: "CIRCLE" | "UNDERLINE", range: Range): boolean;
  /** The orb flies to the range (null: home). */
  point(range: Range | null): void;
  chart(symbol: string): void;
  portfolio(): void;
  /** What Glance is saying, for the panel's line. */
  say(line: string, state: "thinking" | "speaking" | "idle"): void;
  /** The reply ended (or was cancelled): fade the drawings (or clear them). */
  done(cancelled: boolean): void;
  lastGuard?: () => { code: string; message: string } | null;
}

export interface ShowMeRun {
  cancel(): void;
  finished: Promise<void>;
}

/** Runs one Show me answer. */
export function runShowMe(question: string, d: ShowMeDeps): ShowMeRun {
  let cancelled = false;
  let scheduler: ShowScheduler | null = null;
  const act = (a: ShowAction) => {
    if (cancelled) return;
    switch (a.kind) {
      case "POINT":
      case "CIRCLE":
      case "UNDERLINE": {
        const range = d.findQuote(a.quote);
        if (!range) return; // not on the page: skip the drawing, keep talking
        d.reveal(range);
        if (a.kind === "POINT") d.point(range);
        else {
          d.draw(a.kind, range);
          d.point(range);
        }
        return;
      }
      case "CHART":
        return d.chart(a.symbol);
      case "PORTFOLIO":
        return d.portfolio();
    }
  };

  const finished = (async () => {
    d.say("Let me look…", "thinking");
    const page = d.readPage();
    let screenshot: string | undefined;
    if (wantsScreenshot(question)) {
      const shot = await d.capture().catch(() => null);
      screenshot = (shot ? await d.downscale(shot).catch(() => null) : null) ?? undefined;
    }
    if (cancelled) return;
    const res = await d.ask({ question, surface: d.surface, page, ...(screenshot ? { screenshot } : {}), lastGuard: d.lastGuard?.() ?? null });
    if (cancelled) return;
    if (!res.ok) {
      d.say(res.message, "idle");
      return d.done(false);
    }
    const { spoken, actions } = res.data;
    scheduler = new ShowScheduler(actions, spoken, act);
    const s = scheduler;
    d.say(spoken, "thinking");
    await d.speak(spoken, {
      onStart: () => {
        d.say(spoken, "speaking");
        s.start();
      },
      onProgress: (t, dur) => s.progress(t, dur),
      onEnd: () => {},
    });
    if (cancelled) return;
    s.finish(); // voice off, or it ended early: anything left still happens
    d.say(spoken, "idle");
    d.point(null);
    d.done(false);
  })();

  return {
    finished,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      scheduler?.cancel();
      d.hush();
      d.point(null);
      d.done(true);
    },
  };
}

/** Downscales a screenshot (data URL) to at most maxWidth wide, re-encoded as JPEG; base64 without the prefix. */
export async function downscaleJpeg(dataUrl: string, maxWidth = SCREENSHOT_MAX_WIDTH): Promise<string | null> {
  // Decoded here rather than fetched: a page's own content policy can't get in the way.
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  const blob = new Blob([buf], { type: "image/jpeg" });
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
