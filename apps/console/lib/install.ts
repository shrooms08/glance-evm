/**
 * Installing the Glance extension by hand (it isn't in a store yet): the steps, per browser.
 */
export type BrowserKey = "chrome" | "brave" | "arc" | "edge";

/** Every install of Glance has this ID (the manifest's fixed key); the API allows it by name. */
export const GLANCE_EXTENSION_ID = "gmcdcaoneeohbacbnafjdnkkoojgnogl";

/** Glance runs in Chromium browsers only. */
export const UNSUPPORTED_BROWSERS_NOTE = "Firefox and Safari aren't supported: Glance needs Chrome, Brave, Edge or Arc.";

export const BROWSERS: Record<BrowserKey, { name: string; extensionsPage: string; developerMode: string; pin: string }> = {
  chrome: { name: "Chrome", extensionsPage: "chrome://extensions", developerMode: "Turn on Developer mode (top right).", pin: "Click the puzzle piece in the toolbar, then the pin next to Glance." },
  brave: { name: "Brave", extensionsPage: "brave://extensions", developerMode: "Turn on Developer mode (top right).", pin: "Click the puzzle piece in the toolbar, then the pin next to Glance." },
  arc: { name: "Arc", extensionsPage: "arc://extensions", developerMode: "Turn on Developer mode (top right).", pin: "Open the extensions menu in the sidebar and pin Glance." },
  edge: { name: "Edge", extensionsPage: "edge://extensions", developerMode: "Turn on Developer mode (in the left column).", pin: "Click the puzzle piece in the toolbar, then the eye next to Glance to show it." },
};

/** The browser this page is open in, best guess (Arc sets its palette CSS variables; Brave exposes navigator.brave). */
export function detectBrowser(p: { userAgent: string; brave?: unknown; arcPalette?: string }): BrowserKey {
  if (/\bEdg\//.test(p.userAgent)) return "edge";
  if (p.arcPalette) return "arc";
  if (p.brave) return "brave";
  return "chrome";
}

export interface InstallStep {
  title: string;
  detail?: string;
  /** Something to copy (the extensions page's address: browsers don't let a page link to it). */
  copy?: string;
}

export function installSteps(browser: BrowserKey, downloadUrl: string): InstallStep[] {
  const b = BROWSERS[browser];
  return [
    downloadUrl
      ? { title: "Download Glance", detail: "A zip of the extension." }
      : { title: "Build Glance", detail: "No download link is set up here yet: build it with pnpm build:extension, then use apps/extension/.output/chrome-mv3." },
    { title: "Unzip it", detail: "Keep the folder somewhere it will stay: the browser loads Glance from it." },
    { title: `Open ${b.name}'s extensions page`, detail: "Paste this into the address bar (a page can't open it for you).", copy: b.extensionsPage },
    { title: "Turn on Developer mode", detail: b.developerMode },
    { title: "Load unpacked", detail: "Choose the unzipped Glance folder." },
    { title: "Check it's Glance", detail: `Its ID on the extensions page should be ${GLANCE_EXTENSION_ID}.`, copy: GLANCE_EXTENSION_ID },
    { title: "Pin Glance", detail: b.pin },
    { title: "Set me up", detail: "Click the Glance orb (or open its panel) and press Set me up: it opens Get started here, where you connect a wallet and create your vault." },
  ];
}
