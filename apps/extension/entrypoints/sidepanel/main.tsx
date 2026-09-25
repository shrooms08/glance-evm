/**
 * Docked mode: Glance in Chrome's side panel, full height. Same content as the floating panel in a taller layout,
 * with the orb in the header (foundations section 04). Talks to the active tab's content script for the companies it
 * found. Speech started in the panel runs right here (an extension page, under Glance's own microphone permission);
 * speech started on the page runs in the offscreen document and its words are handed over.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";

import { GlanceProvider, useGlance } from "../../components/context";
import { Panel, type PageCompany } from "../../components/Panel";
import { useAssistant } from "../../components/useAssistant";
import { useHotkeys } from "../../components/useHotkeys";
import { speak, warmVoice } from "../../lib/voiceClient";
import { api } from "../../lib/api";
import { useGreeting } from "../../components/useGreeting";
import { glanceLine, keyLabel } from "../../lib/hotkeys";
import { mountPageStyles } from "../../lib/extensionPage";
import type { AssistantMessage } from "../../lib/messages-assistant";
import type { PageMatchesReply } from "../../lib/messages";
import type { PageContext } from "../../lib/journal";
import { defaultMode } from "../../lib/settings";
import { pendingChart, takePendingCard, type PendingCard } from "../../lib/chartPanel";
import { panelMount } from "../../lib/chartLoader";
import { chartAnnotations } from "../../lib/chartAnnotations";
import type { ChartAnnotation } from "@glance/core/showme";

// The chart library comes with this chunk, loaded the first time a chart is shown.
const StockChart = lazy(() => import("../../components/StockChart"));

function SidePanel() {
  const g = useGlance();
  const pageRef = useRef<PageMatchesReply>({ host: "", companies: [] });
  const assistant = useAssistant({
    context: () => ({ host: pageRef.current.host, companies: pageRef.current.companies.map((c) => ({ symbol: c.symbol, mentions: c.mentions })) }),
    // Show me is about the page: the active tab reads it, draws on it and speaks. A browser page (no content script)
    // gets the answer here, without drawings.
    onAsk: (question) => void askOnPage(question),
  });
  const askOnPage = async (question: string) => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    try {
      if (tab?.id === undefined) throw new Error("no tab");
      await browser.tabs.sendMessage(tab.id, { kind: "page:ask", question });
    } catch {
      g.setOrb({ state: "thinking", line: "Let me think…", meta: "Show me" });
      const res = await api.showme({ question, surface: "page" });
      const line = res.ok ? res.data.spoken : res.message;
      g.setOrb({ state: "idle", line, meta: "" });
      if (res.ok) void speak(line, g.voiceReplies, { onStart: () => g.setOrb({ state: "speaking", line, meta: "" }), onEnd: () => g.setOrb({ state: "idle", line, meta: "" }) });
    }
  };
  useGreeting();
  // Docked: Show me on the page draws on the chart here.
  useEffect(() => {
    const onMessage = (msg: { kind?: string; annotation?: ChartAnnotation }) => {
      if (msg?.kind === "chart:annotate" && msg.annotation) chartAnnotations.annotate(msg.annotation);
      return undefined;
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);
  const [page, setPage] = useState<PageMatchesReply>({ host: "", companies: [] });
  pageRef.current = page;

  // Tell the background we are open, so the page hides its floating orb.
  useEffect(() => {
    let port: ReturnType<typeof browser.runtime.connect> | undefined;
    void browser.windows.getCurrent().then((w) => {
      port = browser.runtime.connect({ name: `sidepanel:${w.id}` });
    });
    return () => port?.disconnect();
  }, []);

  /** What the active tab has found. `kind` "page:scan" is a glance (may ask Claude once); "page:matches" never is. */
  const refreshPage = useCallback(async (kind: "page:matches" | "page:scan" = "page:matches") => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    try {
      const reply = (await browser.tabs.sendMessage(tab.id, { kind })) as PageMatchesReply | undefined;
      setPage(reply ?? { host: "", companies: [] });
    } catch {
      setPage({ host: "", companies: [] }); // browser pages and the Web Store have no content script
    }
  }, []);

  useEffect(() => {
    // Opening the panel on a page is a glance; the refreshes after it are passive.
    void refreshPage("page:scan");
    const timer = setInterval(() => void refreshPage(), 5_000);
    const onActivated = () => void refreshPage();
    browser.tabs.onActivated.addListener(onActivated);
    return () => {
      clearInterval(timer);
      browser.tabs.onActivated.removeListener(onActivated);
    };
  }, [refreshPage]);

  // Docked, Glance is always one key away: keep the API's provider connections warm while the panel is open.
  useEffect(() => {
    warmVoice();
    const t = setInterval(warmVoice, 45_000);
    return () => clearInterval(t);
  }, []);

  // The page's hotkeys while docked.
  useEffect(() => {
    const onMessage = (msg: AssistantMessage) => {
      // Option+V held on the page: the panel runs the session, exactly as if it were held here.
      if (msg.kind === "assistant:hold") {
        if (msg.down) assistant.talkDown();
        else assistant.talkUp();
      }
      if (msg.kind === "assistant:glance") {
        setPage(msg.reply);
        g.setOrb({ state: "idle", line: glanceLine(msg.reply.host, msg.reply.companies), meta: `Hold ${keyLabel(g.voiceKey)} to ask about them` });
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [assistant, g]);

  // Option+G in the panel: rescan the active tab and say what was found. Option+V: hold to talk, right here.
  const glance = useCallback(async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    let reply: PageMatchesReply = { host: "", companies: [] };
    if (tab?.id !== undefined) {
      try {
        reply = ((await browser.tabs.sendMessage(tab.id, { kind: "page:scan" })) as PageMatchesReply | undefined) ?? reply;
      } catch {
        // browser pages and the Web Store have no content script
      }
    }
    setPage(reply);
    g.setOrb({ state: "idle", line: glanceLine(reply.host, reply.companies), meta: `Hold ${keyLabel(g.voiceKey)} to ask about them` });
  }, [g]);

  // Not set up yet: the panel shows only its setup card, and the keys do nothing else.
  useHotkeys(
    { glance: g.glanceKey, voice: g.voiceKey },
    {
      onGlance: () => g.gated === false && void glance(),
      onVoiceStart: () => g.gated === false && assistant.talkDown(),
      onVoiceEnd: assistant.talkUp,
      onEscape: () => void assistant.cancelListening(),
    },
  );

  const reveal = async (symbol: string) => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) void browser.tabs.sendMessage(tab.id, { kind: "page:reveal", symbol }).catch(() => {});
  };

  /** A buy from the side panel: ask the active tab which page it is and which sentence named the company. */
  const pageContext = async (symbol: string): Promise<PageContext | null> => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return null;
    try {
      return ((await browser.tabs.sendMessage(tab.id, { kind: "page:context", symbol })) as PageContext | undefined) ?? null;
    } catch {
      return null; // a browser page or the Web Store: not bought from a page
    }
  };

  // "Show me Tesla's chart" said on the page: the request waits in storage for this panel.
  const { setCard } = assistant;
  useEffect(() => {
    const show = (card: PendingCard | null) => {
      if (card?.kind === "chart") setCard({ kind: "chart", symbol: card.symbol, key: Date.now(), ...(card.range ? { range: card.range } : {}) });
      else if (card?.kind === "portfolio") setCard({ kind: "portfolio", key: Date.now() });
    };
    void takePendingCard().then(show);
    return pendingChart.watch((v) => {
      if (v) void takePendingCard().then(show);
    });
  }, [setCard]);

  return (
    <Panel
      layout="tall"
      renderChart={(symbol, onClose, range) => (
        <Suspense fallback={<div className="g-chart-box" aria-busy="true" />}>
          <StockChart key={`${symbol}:${range ?? ""}`} symbol={symbol} initialRange={range} onClose={onClose} mount={panelMount} />
        </Suspense>
      )}
      pageContext={pageContext}
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
