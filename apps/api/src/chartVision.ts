/**
 * POST /chart/calibrate: for a chart on someone else's page whose axis labels aren't text (drawn in a canvas), the
 * extension sends a crop of the chart from a screenshot (activeTab, granted by Option+G), and the model reads ONLY
 * the axis tick labels: text and pixel position, through a tool with a fixed schema. It never gives a price for a
 * point, a coordinate for a dip, or anything else: the scale is fitted in code (@glance/core/page-chart), and every
 * number and mark comes from Glance's own chart facts.
 *
 * CHART_VISION_MODEL (Haiku by default; Sonnet allowed; Opus refused unless ALLOW_OPUS), budget purpose "other". The
 * image is used for this one call: never stored, never logged (the log line is purpose, model and token counts).
 * At most CHART_VISION_DAILY_LIMIT calls a UTC day (default 20): past it, "daily-limit", and the extension lays Glance's
 * own chart (the lens) over the page's instead. The extension also keeps each calibration for 10 minutes, so asking
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

export interface RawLabel {
  axis: "price" | "time";
  text: string;
  x: number;
  y: number;
}

export type VisionResult = { ok: true; labels: RawLabel[]; model: string } | { ok: false; reason: "budget" | "unavailable" | "daily-limit" };

export interface ChartVision {
  readonly model: string;
  readLabels(image: { base64: string; width: number; height: number }): Promise<VisionResult>;
}

const tool = {
  name: "record_axis_labels",
  description: "Record the axis tick labels read from the chart image.",
  input_schema: {
    type: "object" as const,
    properties: {
      labels: {
        type: "array",
        items: {
          type: "object",
          properties: {
            axis: { type: "string", enum: ["price", "time"] },
            text: { type: "string", description: "The label exactly as printed" },
            x: { type: "number", description: "Center of the label text, px from the left of the image" },
            y: { type: "number", description: "Center of the label text, px from the top of the image" },
          },
          required: ["axis", "text", "x", "y"],
        },
      },
    },
    required: ["labels"],
  },
};

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
      const input = use && "input" in use ? (use.input as { labels?: unknown }) : null;
      const labels = Array.isArray(input?.labels) ? (input!.labels as RawLabel[]) : [];
      return { ok: true, labels, model: o.model };
    },
  };
}
