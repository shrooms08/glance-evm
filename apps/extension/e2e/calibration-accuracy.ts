/**
 * Measures the chart lens's calibration on saved screenshots of real chart pages (test/fixtures/charts): each chart is
 * cropped exactly as the extension crops it (lib/pageChart.ts: the chart box plus room for its labels, downscaled to at
 * most 1,000px, JPEG), read by the vision model through a running Glance API (POST /chart/calibrate), fitted in code,
 * and compared with the ground truth (DOM label positions, or label centers measured from the pixels).
 *
 *   node e2e/calibration-accuracy.ts http://localhost:8795 claude-haiku-4-5
 *
 * The model's raw answers are saved next to the fixtures (<name>.vision.<model>.json), so the unit tests replay them
 * offline; the summary goes to test/fixtures/charts/accuracy.json. Needs the API running with that CHART_VISION_MODEL.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { chromium } from "playwright";

import { calibrate, calibrationError, cropFor, parseVisionLabels, type Box } from "@glance/core/page-chart";

const DIR = "test/fixtures/charts";
const api = process.argv[2] ?? "http://localhost:8795";
const model = process.argv[3] ?? "claude-haiku-4-5";
const names = ["google", "yahoo", "tradingview"];

const browser = await chromium.launch();
const page = await browser.newPage();
const report: Record<string, unknown> = {};
for (const name of names) {
  const shot = JSON.parse(readFileSync(`${DIR}/${name}.page.json`, "utf8")) as { chart: Box; capturedAt: string; viewport: [number, number] };
  const truth = JSON.parse(readFileSync(`${DIR}/${name}.truth.json`, "utf8")) as { price: Array<[number, number]>; time: Array<[string, number, number]> };
  const crop = cropFor(shot.chart, { width: shot.viewport[0], height: shot.viewport[1] });
  const b64 = readFileSync(`${DIR}/${name}.png`).toString("base64");
  // The same crop and encoding as the extension (a canvas, downscaled to 1,000px at most, JPEG 0.85).
  const img = await page.evaluate(
    async ({ b64, crop }) => {
      const im = new Image();
      im.src = `data:image/png;base64,${b64}`;
      await im.decode();
      const scale = Math.min(1, 1000 / crop.width);
      const c = document.createElement("canvas");
      c.width = Math.round(crop.width * scale);
      c.height = Math.round(crop.height * scale);
      c.getContext("2d")!.drawImage(im, crop.x, crop.y, crop.width, crop.height, 0, 0, c.width, c.height);
      return { base64: c.toDataURL("image/jpeg", 0.85).split(",")[1]!, width: c.width, height: c.height, scale };
    },
    { b64, crop },
  );
  const started = Date.now();
  const res = await fetch(`${api}/chart/calibrate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: img.base64, width: img.width, height: img.height }) });
  const body = (await res.json()) as { labels?: unknown; model?: string; error?: unknown };
  const ms = Date.now() - started;
  writeFileSync(`${DIR}/${name}.vision.${model}.json`, JSON.stringify({ crop, scale: img.scale, width: img.width, height: img.height, model: body.model ?? model, labels: body.labels ?? [], error: body.error ?? null }, null, 1));
  const labels = parseVisionLabels(body.labels ?? [], crop, img.scale);
  const asOf = Math.floor(Date.parse(shot.capturedAt) / 1000);
  const cal = calibrate(labels, crop, "vision", asOf);
  const truthPairs = { price: truth.price, time: truth.time.map(([, t, px]) => [t, px] as [number, number]) };
  report[name] = cal.ok
    ? { ok: true, model: body.model, ms, bytes: img.base64.length, labelsRead: labels.length, timeAxis: cal.calibration.time.kind, errorPx: calibrationError(cal.calibration, truthPairs) }
    : { ok: false, model: body.model, ms, labelsRead: labels.length, reason: cal.reason };
  console.log(name, JSON.stringify(report[name]));
}
await browser.close();
const file = `${DIR}/accuracy.json`;
let all: Record<string, unknown> = {};
try {
  all = JSON.parse(readFileSync(file, "utf8"));
} catch {
  all = {};
}
all[model] = { measuredAt: new Date().toISOString(), results: report };
writeFileSync(file, JSON.stringify(all, null, 1));
