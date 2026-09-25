/**
 * The chart lens, API side: POST /chart/calibrate (the vision model reads only the axis labels, through a fixed tool
 * schema; the image is never logged; at most CHART_VISION_DAILY_LIMIT calls a day), CHART_VISION_MODEL (Haiku by default, Sonnet allowed, Opus refused), and Show me
 * about a chart on the page: its stock and range give the facts, the Chainlink line is added only when the marks go on
 * the page's own chart, and the number grounding is unchanged. A fake Claude: no network.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { LINES } from "@glance/core/persona";
import { computeFacts } from "@glance/core/chart-facts";

import { createApp } from "../../src/app.js";
import { createChartVision } from "../../src/chartVision.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import type { MessagesClient } from "../../src/llm.js";
import { chooseModel, HAIKU, LlmBudget } from "../../src/llmBudget.js";
import { createShowMe, type ShowMeInput } from "../../src/showme.js";
import { DailyMeter, fileMeter } from "../../src/voice/dailyCaps.js";
import type { ChartSummary } from "../../src/showmeChart.js";
import { FAKE_ANTHROPIC_KEY } from "../support/fake-keys.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const env = { NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" };
const T0 = Date.parse("2026-09-25T08:00:00Z");
const budget = (other = 70) => new LlmBudget({ total: 250, perPurpose: { resolver: 40, intent: 80, why: 60, other } }, null, () => {}, () => T0);
const IMAGE = "A".repeat(2_000);

function visionClient(labels: unknown) {
  const create = vi.fn(async () => ({ content: [{ type: "tool_use", name: "record_axis_labels", input: { labels } }], usage: { input_tokens: 900, output_tokens: 120 }, stop_reason: "tool_use" }));
  return { client: { messages: { create } } as unknown as MessagesClient, create };
}

describe("POST /chart/calibrate", () => {
  const labels = [
    { axis: "price", text: "382.00", x: 952, y: 44 },
    { axis: "time", text: "10:00", x: 37, y: 254 },
  ];

  it("returns only the labels the model read, asked for through a fixed tool, and logs no image", async () => {
    const ctx = createContext(loadConfig(env), () => {});
    const { client, create } = visionClient(labels);
    const lines: string[] = [];
    ctx.chartVision = createChartVision({ model: "claude-sonnet-4-5", budget: budget(), client, log: (l) => lines.push(l) });
    const res = await createApp(ctx).request("/chart/calibrate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: IMAGE, width: 1000, height: 278 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ labels, model: "claude-sonnet-4-5" });
    const params = (create.mock.calls[0] as unknown as [{ tool_choice: unknown; messages: Array<{ content: Array<{ type: string; text?: string }> }> }])[0];
    expect(params.tool_choice).toEqual({ type: "tool", name: "record_axis_labels" });
    expect(params.messages[0]!.content.find((c) => c.type === "text")!.text).toMatch(/Return ONLY the axis tick labels/);
    expect(lines).toEqual(["[llm] other/chart-vision claude-sonnet-4-5 in=900 out=120"]);
  });

  it("the \"other\" budget: used up, 429 and no call", async () => {
    const ctx = createContext(loadConfig(env), () => {});
    const { client, create } = visionClient(labels);
    ctx.chartVision = createChartVision({ model: HAIKU, budget: budget(0), client, log: () => {} });
    const res = await createApp(ctx).request("/chart/calibrate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: IMAGE, width: 1000, height: 278 }) });
    expect(res.status).toBe(429);
    expect(create).not.toHaveBeenCalled();
  });

  it("CHART_VISION_DAILY_LIMIT (default 20): past it, 429 VISION_DAILY_LIMIT and no call (the extension uses the lens)", async () => {
    expect(loadConfig(env).CHART_VISION_DAILY_LIMIT).toBe(20);
    const ctx = createContext(loadConfig(env), () => {});
    const { client, create } = visionClient(labels);
    ctx.chartVision = createChartVision({ model: HAIKU, budget: budget(), client, log: () => {}, daily: new DailyMeter(2) });
    const app = createApp(ctx);
    const read = () => app.request("/chart/calibrate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: IMAGE, width: 1000, height: 278 }) });
    expect((await read()).status).toBe(200);
    expect((await read()).status).toBe(200);
    const res = await read();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VISION_DAILY_LIMIT");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("the count survives a restart the same day, and starts again the next", () => {
    const file = join(mkdtempSync(join(tmpdir(), "glance-vision-")), "chart-vision-usage.json");
    let now = Date.parse("2026-09-25T10:00:00Z");
    const a = fileMeter(20, file, () => now);
    a.add(1);
    a.add(1);
    expect(fileMeter(20, file, () => now).usedToday).toBe(2);
    now = Date.parse("2026-09-26T00:00:01Z");
    expect(fileMeter(20, file, () => now).usedToday).toBe(0);
  });

  it("bad requests: not an image, too small, extra fields", async () => {
    const app = createApp(createContext(loadConfig(env), () => {}));
    for (const body of [{ image: "not base64!", width: 100, height: 100 }, { image: IMAGE, width: 10, height: 100 }, { image: IMAGE, width: 100, height: 100, prompt: "x" }]) {
      expect((await app.request("/chart/calibrate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(400);
    }
  });

  it("CHART_VISION_MODEL: Haiku by default, Sonnet allowed, Opus refused unless ALLOW_OPUS", () => {
    const log: string[] = [];
    expect(chooseModel(undefined, false, "chart vision", (l) => log.push(l))).toBe(HAIKU);
    expect(chooseModel("claude-sonnet-4-5", false, "chart vision", (l) => log.push(l))).toBe("claude-sonnet-4-5");
    expect(chooseModel("claude-opus-4-1", false, "chart vision", (l) => log.push(l))).toBe(HAIKU);
    expect(log.join("\n")).toMatch(/chart vision model "claude-opus-4-1" refused/);
    expect(createContext(loadConfig({ ...env, CHART_VISION_MODEL: "claude-sonnet-4-5", ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY }), () => {}).chartVision?.model).toBe("claude-sonnet-4-5");
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const B = 1_790_230_000;
const P = [
  { t: B, price: 377.89 },
  { t: B + 3_600, price: 382.46 },
  { t: B + 7_200, price: 375.98 },
  { t: B + 10_800, price: 380.25 },
];
const facts = computeFacts({ symbol: "TSLA", name: "Tesla", range: "1D", source: "Chainlink", asOf: B + 11_000, points: P })!;
const summary = { symbol: "TSLA", name: "Tesla", range: "1D", source: "Chainlink", points: P, high: P[1], low: P[2], first: P[0], latest: P[3], markers: [], news: [] } as unknown as ChartSummary;
function showMe(text: string) {
  const create = vi.fn(async () => ({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "end_turn" }));
  return createShowMe({ model: HAIKU, budget: budget(), symbols: ["TSLA", "AMD"], client: { messages: { create } } as unknown as MessagesClient, log: () => {} })!;
}
const input = (drawOn: "page" | "lens"): ShowMeInput => ({
  question: "show me the dip on this chart",
  page: { text: "" },
  charts: [summary],
  facts: [facts],
  pageChart: { symbol: "TSLA", range: "1D", site: "tradingview", drawOn },
});

describe("Show me about a chart on the page", () => {
  it("drawn on the page's own chart: the Chainlink line comes last; on the lens (Chainlink's own chart), it doesn't", async () => {
    const reply = `The dip was to $375.98 [CHART_POINT:TSLA:${B + 7_200}].`;
    expect((await showMe(reply).answer(input("page"))).spoken).toBe(`The dip was to $375.98. ${LINES.chainlinkDiffers}`);
    expect((await showMe(reply).answer(input("lens"))).spoken).toBe("The dip was to $375.98.");
  });

  it("grounding is unchanged: an invented number is still taken out, and the marks use the facts' times", async () => {
    const a = await showMe(`It fell to $371.00 at one point. The low was $375.98 [CHART_POINT:TSLA:${B + 7_100}].`).answer(input("page"));
    expect(a.spoken).toBe(`The low was $375.98. ${LINES.chainlinkDiffers}`);
    expect(a.actions.find((x) => x.kind === "CHART_POINT")).toMatchObject({ t: B + 7_200 });
  });

  it("the route: the page chart's stock and range pick the facts (as if its chart were open)", async () => {
    const ctx = createContext(loadConfig(env), () => {});
    const seen: ShowMeInput[] = [];
    ctx.showMe = { model: HAIKU, answer: async (i) => (seen.push(i), { reply: "ok", spoken: "ok", actions: [], source: "claude" }), answerStream: async () => {} };
    // No network: the chart feed is a fake that has nothing (the answer goes ahead without chart data).
    ctx.chartOverrides = { reader: () => { throw new Error("offline"); }, thresholds: async () => null, now: () => B };
    const res = await createApp(ctx).request("/showme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "explain this chart", pageChart: { symbol: "TSLA", range: "1D", site: "yahoo", drawOn: "page" } }),
    });
    expect(res.status).toBe(200);
    expect(seen[0]!.pageChart).toEqual({ symbol: "TSLA", range: "1D", site: "yahoo", drawOn: "page" });
  });
});
