/**
 * Where each surface gets the full chart from. The side panel: a normal lazy import (its own chunk). The page's
 * content script: the web-accessible chart-mount.js, loaded with import() on first use (a content script is one file,
 * so the library lives outside it).
 */
import type { ChartData } from "@glance/core/chart";
import type { ChartHandle, MountOptions } from "@glance/core/chart-mount";
import { browser } from "wxt/browser";

export type Mount = (el: HTMLElement, data: ChartData, opts: MountOptions) => Promise<ChartHandle>;

let fromPage: Promise<Mount> | null = null;

/** For the content script: loads chart-mount.js once, then mounts with it. */
export const pageMount: Mount = (el, data, opts) => {
  fromPage ??= import(/* @vite-ignore */ browser.runtime.getURL("/chart-mount.js" as never)).then(() => {
    const m = (globalThis as unknown as { __glanceMountChart?: Mount }).__glanceMountChart;
    if (!m) throw new Error("chart script didn't load");
    return m;
  });
  fromPage.catch(() => (fromPage = null));
  return fromPage.then((m) => m(el, data, opts));
};

/** For extension pages (the side panel): a lazily imported chunk. */
export const panelMount: Mount = (el, data, opts) => import("@glance/core/chart-mount").then((m) => m.mountChart(el, data, opts));
