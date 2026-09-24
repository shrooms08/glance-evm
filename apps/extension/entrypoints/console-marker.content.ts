/**
 * Tells the Glance console the extension is installed (Get started, step 5): sets <html data-glance-extension>.
 * Runs only on the console's own origins (lib/consoleOrigins.ts, from WXT_CONSOLE_ORIGINS at build time), does nothing
 * else, and reads nothing from the page. Content script matches grant no host permissions.
 */
import { defineContentScript } from "wxt/utils/define-content-script";

import { consoleMatchPatterns } from "../lib/consoleOrigins";

export default defineContentScript({
  matches: consoleMatchPatterns(import.meta.env.WXT_CONSOLE_ORIGINS),
  runAt: "document_end",
  main() {
    document.documentElement.dataset.glanceExtension = "installed";
  },
});
