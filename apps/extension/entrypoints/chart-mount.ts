/**
 * The full price chart for the floating panel, as its own web-accessible script: the page's content script can't
 * split code, so it loads this with import() the first time a chart opens (lib/chartLoader.ts), and the chart library
 * (Lightweight Charts) never weighs on content.js. The side panel imports the same module directly, lazily.
 */
import { mountChart } from "@glance/core/chart-mount";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

export default defineUnlistedScript(() => {
  (globalThis as unknown as { __glanceMountChart?: typeof mountChart }).__glanceMountChart = mountChart;
});
