/**
 * Docked mode: Glance in Chrome's side panel, full height. Same content as the floating panel in a taller layout,
 * with the orb in the header (foundations section 04). Talks to the active tab's content script for the companies it
 * found, and runs speech the page hands over.
 */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";

import { GlanceProvider, useGlance } from "../../components/context";
import { Panel, type PageCompany } from "../../components/Panel";
import { useAssistant } from "../../components/useAssistant";
import { mountPageStyles } from "../../lib/extensionPage";
import type { AssistantMessage } from "../../lib/messages-assistant";
import type { PageMatchesReply } from "../../lib/messages";
import { defaultMode } from "../../lib/settings";

function SidePanel() {
  const g = useGlance();
  const assistant = useAssistant();
  const [page, setPage] = useState<PageMatchesReply>({ host: "", companies: [] });

  // Tell the background we are open, so the page hides its floating orb.
  useEffect(() => {
    let port: ReturnType<typeof browser.runtime.connect> | undefined;
    void browser.windows.getCurrent().then((w) => {
      port = browser.runtime.connect({ name: `sidepanel:${w.id}` });
    });
    return () => port?.disconnect();
  }, []);

  const refreshPage = useCallback(async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    try {
      const reply = (await browser.tabs.sendMessage(tab.id, { kind: "page:matches" })) as PageMatchesReply | undefined;
      setPage(reply ?? { host: "", companies: [] });
    } catch {
      setPage({ host: "", companies: [] }); // browser pages and the Web Store have no content script
    }
  }, []);

  useEffect(() => {
    void refreshPage();
    const timer = setInterval(refreshPage, 5_000);
    const onActivated = () => void refreshPage();
    browser.tabs.onActivated.addListener(onActivated);
    return () => {
      clearInterval(timer);
      browser.tabs.onActivated.removeListener(onActivated);
    };
  }, [refreshPage]);

  // Speech captured on the page while docked.
  useEffect(() => {
    const onMessage = (msg: AssistantMessage) => {
      if (msg.kind === "assistant:listening") g.setOrb({ state: "listening", line: "Listening…", meta: "Release to send" });
      if (msg.kind === "assistant:heard") g.setOrb({ state: "listening", line: `“${msg.text}”`, meta: "Release to send" });
      if (msg.kind === "assistant:run") {
        if (msg.text) void assistant.run(msg.text);
        else g.setOrb({ state: "idle", line: "I didn't hear anything.", meta: "" });
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [assistant, g]);

  // Hold Option+<letter> while the side panel has focus.
  useEffect(() => {
    const code = `Key${g.hotkey.toUpperCase()}`;
    let held = false;
    const down = (e: KeyboardEvent) => {
      if (e.code !== code || !e.altKey || e.repeat || held) return;
      e.preventDefault();
      held = true;
      assistant.startListening();
    };
    const up = (e: KeyboardEvent) => {
      if (held && (e.code === code || e.key === "Alt")) {
        held = false;
        assistant.stopListening();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [g.hotkey, assistant]);

  const reveal = async (symbol: string) => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) void browser.tabs.sendMessage(tab.id, { kind: "page:reveal", symbol }).catch(() => {});
  };

  return (
    <Panel
      layout="tall"
      assistant={assistant}
      host={page.host}
      companies={page.companies as PageCompany[]}
      onRevealCompany={(s) => void reveal(s)}
      onSwitchMode={() => {
        void defaultMode.setValue("floating").then(() => window.close());
      }}
    />
  );
}

mountPageStyles();
createRoot(document.getElementById("root")!).render(
  <GlanceProvider idleLine="">
    <div className="g-root" style={{ display: "block", height: "100vh" }}>
      <SidePanel />
    </div>
  </GlanceProvider>,
);
