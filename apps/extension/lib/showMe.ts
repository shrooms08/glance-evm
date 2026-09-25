/**
 * Show me, teach and guide, on the page. Only on an explicit request (a held Option+V, or a question typed in the
 * panel). Reads the page (lib/pageRead.ts), adds a screenshot only for a question about a chart or an image, asks the
 * API (POST /showme), then speaks the whole answer as one TTS call and acts on its tags in step with the voice
 * (lib/showScheduler.ts): the orb flies to a quote, circles and underlines are drawn (lib/showDraw.ts), a chart or the
 * portfolio opens. A quote that isn't on the page is skipped silently. Escape (or a new question) cancels it all.
 */
import type { ChartRange } from "@glance/core/chart";
import type { ChartAnnotation, ShowAction } from "@glance/core/showme";
import { VOICE_RESTING } from "@glance/core/session";

import type { ShowMeReply, ShowMeRequest } from "./api";
import type { StreamSentence } from "./showStream";
import type { PartsHandlers } from "./voiceClient";
import { wantsScreenshot, type PageRead } from "./pageRead";
import { ShowScheduler } from "./showScheduler";

export const SCREENSHOT_MAX_WIDTH = 960;
/** A screenshot's base64 at most (the API takes 64 KB of JSON in all, page text included). */
export const SCREENSHOT_MAX_CHARS = 36_000;
/** The whole Show me request at most, in bytes: under the API's 64 KB limit, with room to spare. */
export const SHOW_ME_MAX_BODY_BYTES = 60_000;

const byteLength = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;

/**
 * Fits a Show me request under the API's size limit: the screenshot goes if it's too big, then the page text is
 * shortened from the end (the opening, which says what the page is, is kept).
 */
export function fitShowMeBody(body: ShowMeRequest, max = SHOW_ME_MAX_BODY_BYTES): ShowMeRequest {
  let out = body;
  if (out.screenshot && out.screenshot.length > SCREENSHOT_MAX_CHARS) out = { ...out, screenshot: undefined };
  if (byteLength(out) <= max || !out.page) return out;
  let text = out.page.text;
  while (text.length > 0 && byteLength({ ...out, page: { ...out.page, text } }) > max) {
    const over = byteLength({ ...out, page: { ...out.page, text } }) - max;
    text = text.slice(0, Math.max(0, text.length - Math.max(256, over)));
  }
  out = { ...out, page: { ...out.page, text } };
  if (byteLength(out) > max && out.screenshot) out = { ...out, screenshot: undefined };
  return out;
}
/** Under the answer when the voice stopped part way. */
export const CUT_NOTE = "The voice stopped there. The rest is written above.";
/** Under the answer when there's no voice right now. */
export const NO_VOICE_NOTE = "No voice right now. The answer is written above.";

/** The note under a reply that wasn't spoken: no voice right now, or today's voice is used up. */
export function noVoiceNote(outcome: string): string | undefined {
  return outcome === "resting" ? VOICE_RESTING : outcome === "unavailable" ? NO_VOICE_NOTE : undefined;
}

export interface ShowMeDeps {
  readPage(): PageRead;
  surface: "page" | "console";
  /** A JPEG data URL of the visible tab, or null. */
  capture(): Promise<string | null>;
  /** Downscales a data URL to at most SCREENSHOT_MAX_WIDTH wide, as base64 JPEG (no prefix). */
  downscale(dataUrl: string): Promise<string | null>;
  ask(body: ShowMeRequest): Promise<{ ok: true; data: ShowMeReply } | { ok: false; message: string }>;
  /**
   * Speaks the text as one call in Glance's voice; progress reports playback time and (once known) duration. Resolves
   * with how it went: "cut" means the voice stopped mid-reply (never continued in another voice).
   */
  speak(text: string, h: { onStart(): void; onProgress(t: number, d: number | null): void; onEnd(): void }): Promise<"ended" | "cut" | "unavailable" | "resting" | "off">;
  hush(): void;
  findQuote(quote: string): Range | null;
  reveal(range: Range): void;
  draw(kind: "CIRCLE" | "UNDERLINE" | "BOX" | "HIGHLIGHT", range: Range): boolean;
  drawArrow(from: Range, to: Range): boolean;
  /** Box the nth figure listed with the page (false if there's no such figure). */
  drawFigure(n: number): boolean;
  /** The orb flies to the range (null: home). */
  point(range: Range | null): void;
  /** Open a stock's chart (on the range that fits the question). */
  chart(symbol: string, range?: ChartRange): void;
  /** Draw on a Glance chart (it applies once the chart is showing). */
  annotate(a: ChartAnnotation): void;
  /** A Glance chart open right now, if any. */
  openChart?(): { symbol: string; range: ChartRange } | null;
  portfolio(): void;
  /** What Glance is saying, for the panel's line (and a note under it). */
  say(line: string, state: "thinking" | "speaking" | "idle", note?: string): void;
  /** The reply ended (or was cancelled): fade the drawings (or clear them). */
  done(cancelled: boolean): void;
  lastGuard?: () => { code: string; message: string } | null;
  /** The vault (for "since your last buy" in chart answers). */
  vault?: () => string | undefined;
  /** The glance key's label (⌥G): said when a chart on the page can't be seen (no screenshot without it). */
  glanceKey?: () => string;
  /**
   * Streamed answers (preferred when given): each sentence arrives as soon as Claude has written it, and is spoken as
   * one part of the reply while the next is still being written.
   */
  askStream?(body: ShowMeRequest, onSentence: (s: StreamSentence) => void): Promise<{ ok: true; source: string } | { ok: false; message: string }>;
  speakParts?(h: PartsHandlers): { push(text: string): number | null; end(): void; result: Promise<"ended" | "cut" | "unavailable" | "resting" | "off"> };
}

export interface ShowMeRun {
  cancel(): void;
  finished: Promise<void>;
}

/**
 * The request: the question and the page, a screenshot when there is one, and (when a chart or image was asked about
 * and none could be taken) a flag so the answer says how to allow it.
 */
function showMeBody(question: string, d: ShowMeDeps, page: ReturnType<ShowMeDeps["readPage"]>, screenshot: string | undefined): ShowMeRequest {
  const vault = d.vault?.();
  return {
    question,
    surface: d.surface,
    page,
    openChart: d.openChart?.() ?? null,
    ...(screenshot ? { screenshot } : {}),
    lastGuard: d.lastGuard?.() ?? null,
    ...(vault ? { vault } : {}),
    ...(!screenshot && wantsScreenshot(question) ? { noScreenshot: { glanceKey: d.glanceKey?.() ?? "⌥G" } } : {}),
  };
}

/** Runs one Show me answer. */
export function runShowMe(question: string, d: ShowMeDeps): ShowMeRun {
  let cancelled = false;
  let scheduler: ShowScheduler | null = null;
  let chartRange: ChartRange | undefined;
  const act = (a: ShowAction) => {
    if (cancelled) return;
    switch (a.kind) {
      case "POINT":
      case "CIRCLE":
      case "UNDERLINE":
      case "BOX":
      case "HIGHLIGHT": {
        const range = d.findQuote(a.quote);
        if (!range) return; // not on the page: skip the drawing, keep talking
        d.reveal(range);
        if (a.kind !== "POINT") d.draw(a.kind, range);
        d.point(range);
        return;
      }
      case "ARROW": {
        const from = d.findQuote(a.from);
        const to = d.findQuote(a.to);
        if (!from || !to) return; // either end missing: no arrow
        d.reveal(from);
        d.drawArrow(from, to);
        return;
      }
      case "BOX_FIGURE":
        d.drawFigure(a.figure);
        return;
      case "CHART":
        return d.chart(a.symbol, chartRange);
      case "PORTFOLIO":
        return d.portfolio();
      default:
        // CHART_POINT, CHART_LEVEL, CHART_RANGE, CHART_TREND: on Glance's own chart.
        return d.annotate(a);
    }
  };

  const finished = (async () => {
    if (d.askStream && d.speakParts) return streamed();
    d.say("Let me look…", "thinking");
    const page = d.readPage();
    let screenshot: string | undefined;
    if (wantsScreenshot(question)) {
      const shot = await d.capture().catch(() => null);
      screenshot = (shot ? await d.downscale(shot).catch(() => null) : null) ?? undefined;
    }
    if (cancelled) return;
    const res = await d.ask(fitShowMeBody(showMeBody(question, d, page, screenshot)));
    if (cancelled) return;
    if (!res.ok) {
      d.say(res.message, "idle");
      return d.done(false);
    }
    const { spoken, actions } = res.data;
    chartRange = res.data.chart?.range;
    scheduler = new ShowScheduler(actions, spoken, act);
    const s = scheduler;
    d.say(spoken, "thinking");
    const outcome = await d.speak(spoken, {
      onStart: () => {
        d.say(spoken, "speaking");
        s.start();
      },
      onProgress: (t, dur) => s.progress(t, dur),
      onEnd: () => {},
    });
    if (cancelled) return;
    if (outcome === "cut") {
      // The voice stopped mid-reply: the drawings stay where the words got to, and the whole answer is on screen.
      s.cancel();
      d.say(spoken, "idle", CUT_NOTE);
    } else {
      s.finish(); // spoken replies off, or no voice: anything left still happens with the text on screen
      d.say(spoken, "idle", noVoiceNote(outcome));
    }
    d.point(null);
    d.done(false);
  })();

  /**
   * Streamed: each sentence has its own scheduler, started when its part starts playing and driven by that part's
   * progress, so its tags fire relative to its own audio. A cut stops the drawings where the words got to.
   */
  const perPart: ShowScheduler[] = [];
  const everyScheduler: ShowScheduler[] = [];
  async function streamed() {
    d.say("Let me look…", "thinking");
    const page = d.readPage();
    let screenshot: string | undefined;
    if (wantsScreenshot(question)) {
      const shot = await d.capture().catch(() => null);
      screenshot = (shot ? await d.downscale(shot).catch(() => null) : null) ?? undefined;
    }
    if (cancelled) return;
    let full = "";
    let cutAt: number | null = null;
    const voice = d.speakParts!({
      onPart: (i) => perPart[i]?.start(),
      onProgress: (i, t, dur) => perPart[i]?.progress(t, dur),
      onPartEnd: (i) => perPart[i]?.finish(),
      onCut: (i) => (cutAt = i),
    });
    const res = await d.askStream!(fitShowMeBody(showMeBody(question, d, page, screenshot)), (sentence) => {
      if (cancelled) return;
      if (sentence.chart) chartRange = sentence.chart.range;
      const sched = new ShowScheduler(sentence.actions, sentence.spoken, act);
      everyScheduler.push(sched);
      if (sentence.spoken) full = full ? `${full} ${sentence.spoken}` : sentence.spoken;
      d.say(full, "speaking");
      const part = voice.push(sentence.spoken);
      if (part === null) sched.finish(); // no words (tags only), or spoken replies off: act now
      else perPart[part] = sched;
    });
    voice.end();
    if (cancelled) return;
    if (!res.ok && !full) {
      d.say(res.message, "idle");
      return d.done(false);
    }
    const outcome = await voice.result;
    if (cancelled) return;
    if (outcome === "cut") {
      // Stopped part way: what was said keeps its drawings; nothing after the cut fires; the whole answer is written.
      for (const [i, sched] of perPart.entries()) if (cutAt === null || i >= cutAt) sched?.cancel();
      d.say(full, "idle", CUT_NOTE);
    } else {
      for (const sched of everyScheduler) sched.finish();
      d.say(full, "idle", noVoiceNote(outcome));
    }
    d.point(null);
    d.done(false);
  }

  return {
    finished,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      scheduler?.cancel();
      for (const sched of everyScheduler) sched.cancel();
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
  // Smaller until it fits the request's size limit (a chart stays readable at 540px); too big even then: none.
  try {
    for (const width of [maxWidth, 720, 540]) {
      const scale = Math.min(1, width / bitmap.width);
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
      const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
      const bytes = new Uint8Array(await out.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const b64 = btoa(bin);
      if (b64.length <= SCREENSHOT_MAX_CHARS) return b64;
    }
    return null;
  } finally {
    bitmap.close();
  }
}
