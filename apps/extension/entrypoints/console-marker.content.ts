/**
 * On the Glance console's own pages only (lib/consoleOrigins.ts, from WXT_CONSOLE_ORIGINS at build time): marks the
 * page as having Glance (<html data-glance-extension>), and runs the console <-> extension handshake
 * (lib/handshake.ts) so the owner never pastes a vault address or opens settings to link. It reads nothing else from
 * the page. The session's private key never leaves the background worker: only its address is said here.
 */
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

import { api } from "../lib/api";
import { consoleMatchPatterns, consoleOrigins } from "../lib/consoleOrigins";
import { createHandshake } from "../lib/handshake";
import type { SessionInfo } from "../lib/messages";
import { sessionLink } from "../lib/session";
import { isOpenDemoVault } from "../lib/linking";
import { vaultAddress, vaultSource } from "../lib/settings";

export default defineContentScript({
  matches: consoleMatchPatterns(import.meta.env.WXT_CONSOLE_ORIGINS),
  runAt: "document_end",
  main() {
    document.documentElement.dataset.glanceExtension = "installed";
    const handshake = createHandshake({
      allowedOrigins: consoleOrigins(import.meta.env.WXT_CONSOLE_ORIGINS),
      pageOrigin: location.origin,
      post: (m) => window.postMessage(m, location.origin),
      version: browser.runtime.getManifest().version,
      shortcuts: async () => (await browser.runtime.sendMessage({ kind: "commands:get" })) as { glance: string; talk: string },
      sessionAddress: async () => ((await browser.runtime.sendMessage({ kind: "session:info" })) as SessionInfo).address,
      // The vault Glance uses: the one the console set, or one typed by hand; the open demo vault by default.
      vault: () => vaultAddress.getValue(),
      isDemo: isOpenDemoVault,
      link: () => sessionLink.getValue(),
      setVault: async (vault) => {
        await vaultAddress.setValue(vault);
        await vaultSource.setValue("console");
      },
      setLink: (link) => (link ? sessionLink.setValue(link) : sessionLink.removeValue()),
      status: async (vault, session) => {
        const res = await api.sessionStatus(vault, session);
        if (!res.ok) return null;
        return res.data.linked ? { linked: true, expiresAt: res.data.expiresAt } : { linked: false };
      },
    });
    if (!handshake.allowed) return;
    window.addEventListener("message", (event) => {
      void handshake.receive({ origin: event.origin, data: event.data, fromThisWindow: event.source === window });
    });
    void handshake.sayHello().catch(() => {});
  },
});
