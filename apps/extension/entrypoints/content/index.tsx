/**
 * Content script: mounts Glance's in-page UI inside a shadow root (so the host page cannot style us and we cannot
 * style it), and runs the company underliner. Top frame only. When the extension is reloaded under an open tab, it
 * shuts itself down once and leaves a refresh notice (lib/pageLifecycle.ts).
 */
import { createRoot, type Root } from "react-dom/client";
import { browser } from "wxt/browser";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { defineContentScript } from "wxt/utils/define-content-script";

import { contextAlive } from "../../lib/lifecycle";
import { installPageLifecycle } from "../../lib/pageLifecycle";
import { Sfx } from "../../lib/sfx";
import { stylesheet } from "../../lib/styles";
import { layer } from "../../lib/tokens";
import { injectPageStyles, Underliner } from "../../lib/underline";
import { App } from "./App";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  // We pass our generated stylesheet to createShadowRootUi ourselves; there is no content-script CSS file to fetch.
  cssInjectionMode: "manual",
  async main(ctx) {
    if (window.top !== window || !document.body || !contextAlive()) return;
    // Reloading or updating Glance orphans this script: shut down quietly and leave a refresh notice.
    installPageLifecycle(ctx);
    injectPageStyles((path) => browser.runtime.getURL(path as "/glance-mark.png"));
    // Decode the open and close sounds now, so the first open has no load delay. Silent on any failure.
    const sfx = new Sfx({
      createContext: () => new AudioContext(),
      load: async (path) => (await fetch(browser.runtime.getURL(path as "/glance-mark.png"))).arrayBuffer(),
      target: window,
    });
    void sfx.init();
    ctx.onInvalidated(() => sfx.dispose());

    const ui = await createShadowRootUi<Root>(ctx, {
      name: "glance-orb",
      position: "inline",
      anchor: document.documentElement,
      append: "last",
      css: stylesheet(),
      // Keys typed into our inputs must not trigger the host page's shortcuts.
      isolateEvents: ["keydown", "keyup", "keypress"],
      onMount(container, _shadow, host) {
        host.setAttribute("style", `all: initial !important; position: fixed !important; inset: 0 !important; pointer-events: none !important; z-index: ${layer.host} !important;`);
        // Started by the App once Glance is set up (nothing is underlined before that).
        const underliner = new Underliner(host);
        ctx.onInvalidated(() => underliner.stop());
        const root = createRoot(container);
        root.render(<App underliner={underliner} sfx={sfx} />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    ui.mount();
  },
});
