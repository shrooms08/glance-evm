/**
 * Replays the saved calibrations of the real chart pages (test/fixtures/charts) through the sanity check, with real
 * Chainlink TSLA prices (tsla-1d.facts.json, fetched when the pages were captured) and the page's line read from the
 * screenshot's pixels by the extension's own reader: which calibrations Glance would draw with, and which would fall
 * back to the lens. No network.   node e2e/calibration-sanity.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

import { chromium } from "playwright";

import { calibrate, cropFor, parseVisionLabels, sanityCheck, type AxisLabel, type Box } from "@glance/core/page-chart";

import { pixelLineReader } from "../lib/pageChart.ts";

const DIR = "test/fixtures/charts";
const facts = JSON.parse(readFileSync(`${DIR}/tsla-1d.facts.json`, "utf8")).facts[0];
const points = (JSON.parse(readFileSync(`${DIR}/tsla-1d.chart.json`, "utf8")).points as Array<{ t: number; price: number }>).map((p) => ({ t: p.t, price: p.price }));
const browser = await chromium.launch();
const page = await browser.newPage();
const out: Record<string, unknown> = {};
for (const name of ["google", "yahoo", "tradingview"]) {
  const shot = JSON.parse(readFileSync(`${DIR}/${name}.page.json`, "utf8")) as { chart: Box; capturedAt: string; viewport: [number, number]; labels: AxisLabel[] };
  const asOf = Math.floor(Date.parse(shot.capturedAt) / 1000);
  const crop = cropFor(shot.chart, { width: shot.viewport[0], height: shot.viewport[1] });
  const b64 = readFileSync(`${DIR}/${name}.png`).toString("base64");
  const pixels = await page.evaluate(
    async ({ b64, crop }) => {
      const im = new Image();
      im.src = `data:image/png;base64,${b64}`;
      await im.decode();
      const c = document.createElement("canvas");
      c.width = crop.width;
      c.height = crop.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(im, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
      return { data: [...ctx.getImageData(0, 0, crop.width, crop.height).data], width: crop.width, height: crop.height };
    },
    { b64, crop },
  );
  const lineAt = pixelLineReader({ data: Uint8ClampedArray.from(pixels.data), width: pixels.width, height: pixels.height }, crop, 1);
  // The page's line as read from the pixels, at every x across the crop: the unit tests replay it offline.
  const line: Record<number, number[]> = {};
  for (let x = Math.ceil(crop.x); x < crop.x + crop.width; x++) {
    const ys = lineAt(x);
    if (ys && ys.length) line[x] = ys.map((y) => Math.round(y * 10) / 10);
  }
  writeFileSync(`${DIR}/${name}.line.json`, JSON.stringify(line));
  const runs: Record<string, unknown> = {};
  const check = (label: string, labels: AxisLabel[], box: Box, method: "dom" | "vision") => {
    const cal = calibrate(labels, box, method, asOf);
    if (!cal.ok) return (runs[label] = { calibrated: false, reason: cal.reason, drawsOn: "lens" });
    const s = sanityCheck(cal.calibration, { high: facts.high, low: facts.low, probes: points, lineAt });
    runs[label] = { calibrated: true, sane: s.ok, reason: s.reason, drawsOn: s.ok ? "page" : "lens" };
  };
  if (name === "google") check("dom", shot.labels, shot.chart, "dom");
  for (const model of ["claude-haiku-4-5", "claude-sonnet-4-5"]) {
    try {
      const v = JSON.parse(readFileSync(`${DIR}/${name}.vision.${model}.json`, "utf8"));
      check(model, parseVisionLabels(v.labels, v.crop, v.scale), v.crop, "vision");
    } catch {
      runs[model] = "not measured";
    }
  }
  out[name] = runs;
  console.log(name, JSON.stringify(runs));
}
await browser.close();
writeFileSync(`${DIR}/sanity.json`, JSON.stringify(out, null, 1));
