/**
 * POST /chart/calibrate: for a chart on someone else's page whose axis labels aren't text (drawn in a canvas), the
 * extension sends a crop of the chart from a screenshot (activeTab, granted by Option+G), and the model reads ONLY
 * the chart's geometry: the plotting area's box, at least 2 price ticks {price, y} and at least 2 time ticks {time, x},
 * through a tool with a fixed schema. It never gives a price for a point, a coordinate for a dip, or anything else: the
 * scale is fitted and validated in code (the extension, lib/chartLensFlow.ts), and every mark comes from Glance's own
 * computed facts. The canvas trace and the DOM labels are tried first; this is the third method.
 *
 * CHART_VISION_MODEL (claude-sonnet-4-5 by default; never Opus unless ALLOW_OPUS), budget purpose "other". The
 * image is used for this one call: never stored, never logged (the log line is purpose, model and token counts).
 * At most CHART_VISION_DAILY_LIMIT calls a UTC day (default 20): past it, "daily-limit", and the extension lays Glance's
 * The extension then draws nothing and asks (rule 3). It also keeps each calibration for 10 minutes, so asking
 * about the same chart again makes no new call.
 */
import Anthropic from "@anthropic-ai/sdk";

import { VISION_INSTRUCTIONS } from "@glance/core/page-chart";

import { anthropicFetch } from "./anthropicHttp.js";
import type { DailyMeter } from "./voice/dailyCaps.js";
import type { MessagesClient } from "./llm.js";
import { logUsage, type LlmBudget, type Log } from "./llmBudget.js";

export const VISION_MAX_OUTPUT_TOKENS = 1_200;
/** A JPEG crop's base64 at most (a chart crop at 1,000px wide is about 60 to 120 KB). */
export const VISION_MAX_IMAGE_CHARS = 400_000;

/** What the model reads: the plot box and the axis ticks, in the image's pixels. Never a price for a point. */
export interface ChartGeometry {
  plot: { x: number; y: number; width: number; height: number } | null;
  price: Array<{ price: number; y: number }>;
  time: Array<{ time: string; x: number }>;
}

export type VisionResult = { ok: true; labels: ChartGeometry; model: string } | { ok: false; reason: "budget" | "unavailable" | "daily-limit" };

export interface ChartVision {
  readonly model: string;
  readLabels(image: { base64: string; width: number; height: number }): Promise<VisionResult>;
}

const tool = {
  name: "record_chart_geometry",
  description: "Record the chart's plotting area and its axis tick labels, read from the image.",
  input_schema: {
    type: "object" as const,
    properties: {
      plot: {
        type: "object",
        description: "The plotting area (where the line or candles are drawn), px from the image's top-left",
        properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        required: ["x", "y", "width", "height"],
      },
      price: {
        type: "array",
        description: "At least 2 price-axis tick labels",
        items: { type: "object", properties: { price: { type: "number", description: "The number printed" }, y: { type: "number", description: "Center of the label, px from the top" } }, required: ["price", "y"] },
      },
      time: {
        type: "array",
        description: "At least 2 time-axis tick labels",
        items: { type: "object", properties: { time: { type: "string", description: "The label exactly as printed" }, x: { type: "number", description: "Center of the label, px from the left" } }, required: ["time", "x"] },
      },
    },
    required: ["plot", "price", "time"],
  },
};

/** The model's answer, checked: numbers only where numbers belong. */
export function toGeometry(input: unknown): ChartGeometry {
  const r = (input ?? {}) as { plot?: Record<string, unknown>; price?: unknown; time?: unknown };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const plot = r.plot && [r.plot.x, r.plot.y, r.plot.width, r.plot.height].every((v) => n(v) !== null) ? { x: n(r.plot.x)!, y: n(r.plot.y)!, width: n(r.plot.width)!, height: n(r.plot.height)! } : null;
  const price = (Array.isArray(r.price) ? r.price : []).flatMap((p: { price?: unknown; y?: unknown }) => (n(p?.price) !== null && n(p?.y) !== null ? [{ price: n(p.price)!, y: n(p.y)! }] : []));
  const time = (Array.isArray(r.time) ? r.time : []).flatMap((t: { time?: unknown; x?: unknown }) => (typeof t?.time === "string" && t.time.length <= 16 && n(t?.x) !== null ? [{ time: t.time, x: n(t.x)! }] : []));
  return { plot, price, time };
}

export function createChartVision(o: { apiKey?: string; model: string; budget: LlmBudget; log?: Log; client?: MessagesClient; daily?: DailyMeter | null }): ChartVision | null {
  if (!o.apiKey && !o.client) return null;
  const log = o.log ?? ((l: string) => console.log(l));
  const client: MessagesClient = o.client ?? new Anthropic({ apiKey: o.apiKey, timeout: 20_000, maxRetries: 0, fetch: anthropicFetch });
  return {
    model: o.model,
    async readLabels(image) {
      if (o.daily?.resting) return { ok: false, reason: "daily-limit" };
      if (!o.budget.tryAcquire("other")) return { ok: false, reason: "budget" };
      // Every call that reaches the model counts, answered or not.
      o.daily?.add(1);
      let response;
      try {
        response = await client.messages.create({
          model: o.model,
          max_tokens: VISION_MAX_OUTPUT_TOKENS,
          tools: [tool],
          tool_choice: { type: "tool", name: tool.name },
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.base64 } },
                { type: "text", text: `${VISION_INSTRUCTIONS}\nThe image is ${image.width} x ${image.height} pixels.` },
              ],
            },
          ],
        });
      } catch (err) {
        o.budget.failed(err);
        return { ok: false, reason: "unavailable" };
      }
      logUsage(log, "other/chart-vision", o.model, response.usage);
      const use = response.content.find((b) => b.type === "tool_use");
      return { ok: true, labels: toGeometry(use && "input" in use ? use.input : null), model: o.model };
    },
  };
}
