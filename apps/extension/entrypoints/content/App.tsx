/**
 * The in-page Glance UI: a draggable orb, its compact panel (which melts out of the orb, components/GooPanel.tsx), the
 * hover card on underlined company names, and the weekend badge. Option+G (tap) glances at the page; Option+V (hold)
 * talks; clicking the orb docks Glance to the side panel. When the user has docked Glance and the side panel is open, the orb hides entirely (it must never
 * cover the page's own controls) and speech started here is handed to the side panel. Speech itself never runs in the
 * page: lib/voiceClient runs it in Glance's offscreen document.
 */
import { during } from "../../lib/workLabel";
import { relinkLine } from "../../components/Setup";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { browser } from "wxt/browser";

import { CompanyCard, WeekendBadge } from "../../components/CompanyCard";
import { GlanceProvider, marketClosed, useGlance } from "../../components/context";
import { Orb } from "../../components/Orb";
import { DockTransition } from "../../components/DockTransition";
import { GooPanel, orbDisc } from "../../components/GooPanel";
import { Panel, type PageCompany } from "../../components/Panel";
import { useAssistant } from "../../components/useAssistant";
import { useHotkeys } from "../../components/useHotkeys";
import { useOrbMotion } from "../../components/useOrbMotion";
import { reportIdleFrames, sampleFrames } from "../../lib/motionBudget";
import { glanceLine, keyLabel } from "../../lib/hotkeys";
import { safely, send } from "../../lib/lifecycle";
import type { AssistantMessage } from "../../lib/messages-assistant";
import type { VoiceCommandContext } from "../../lib/voiceMessages";
import type { Message, PageMatchesReply } from "../../lib/messages";
import { calibrationDots, defaultMode, devTools, orbPosition, type OrbPosition } from "../../lib/settings";
import { SoundCue, type Sfx } from "../../lib/sfx";
import { orb as orbTokens } from "../../lib/tokens";
import type { Mention, Underliner } from "../../lib/underline";
import { requestCard } from "../../lib/chartPanel";
import StockChart from "../../components/StockChart";
import { greeted } from "../../components/useGreeting";
import { Tour, Welcome } from "../../components/Onboarding";
import { firstRun, hotkeyTip, prefersReducedMotion, takeHotkeyTip, tick, tourDone, tourSteps } from "../../lib/onboarding";
import { createCommandTalk } from "../../lib/commandTalk";
import { GREETING, LINES, SPOKEN_GREETING } from "@glance/core/persona";
import { api } from "../../lib/api";
import { findQuote, nextSentence, revealRange } from "../../lib/anchor";
import { pageMount } from "../../lib/chartLoader";
import { listFigures, readPage } from "../../lib/pageRead";
import { chartAnnotations } from "../../lib/chartAnnotations";
import { afterAnswer, watchNavigation } from "../../lib/markLife";
import { ChartLayer } from "../../lib/chartLayer";
import { placeOwnChart, wantsOwnChart } from "../../lib/ownChart";
import type { Box } from "@glance/core/page-chart";
import { chartPathLine, defaultMarks, preparePageChart, type PageChartSession } from "../../lib/chartLensFlow";
import { companiesInText } from "../../lib/commands";
import { chooseChartRoute, findChartCandidates, isTradingViewChartPage, pageStock, readTradingViewChart, selectedRange } from "../../lib/pageChart";
import { ChartAnswers, RANGE_BUTTON, rangeFromAnswer } from "../../lib/chartAsk";
import type { ChartRange } from "@glance/core/chart";
import { ShowDrawings } from "../../lib/showDraw";
import { CUT_NOTE, downscaleJpeg, runShowMe, type ShowMeRun } from "../../lib/showMe";
import { candleAnswer, explainerAnswer, explainsChart, NO_CHART_FOR_CANDLES, strongPatternSentence, type CandleSentence } from "../../lib/candleAnswer";
import { candleIntent } from "@glance/core/candles";
import { hush, speak, speakParts, warmVoice } from "../../lib/voiceClient";
import { askStream } from "../../lib/showStreamClient";
import { capturePage, type PageContext } from "../../lib/journal";
import { rememberOrbAnchor } from "../../lib/updatedNotice";

const HOVER_DWELL_MS = 300;
const HOVER_GRACE_MS = 250;
const DRAG_THRESHOLD = 4;

export function App({ underliner, sfx }: { underliner: Underliner; sfx?: Sfx }) {
  return (
    <GlanceProvider idleLine="">
      <div className="g-root">
        <Floating underliner={underliner} sfx={sfx} />
      </div>
    </GlanceProvider>
  );
}

function companiesFrom(mentions: Mention[], catalog: ReturnType<typeof useGlance>["catalog"]): PageCompany[] {
  const counts = new Map<string, number>();
  for (const m of mentions) counts.set(m.symbol, (counts.get(m.symbol) ?? 0) + 1);
  return [...counts.entries()]
    .map(([symbol, mentions]) => ({ symbol, mentions, name: catalog.find((c) => c.symbol === symbol)?.name ?? symbol }))
    .sort((a, b) => b.mentions - a.mentions);
}

function Floating({ underliner, sfx }: { underliner: Underliner; sfx?: Sfx }) {
  const g = useGlance();
  /**
   * The open and close sounds belong to four gestures only: the Option+G tap, the orb's Enter/Space, Escape and the
   * panel's close button. Each asks for its sound here; GooPanel plays it on the frame the liquid starts moving. Any
   * other open or close (voice, a card, docking) asks for nothing, so it stays silent.
   */
  const soundCue = useRef(new SoundCue());
  useEffect(() => sfx?.setEnabled(g.sounds), [sfx, g.sounds]);
  const voiceContext = useRef<() => VoiceCommandContext>(() => ({}));
  // "Show me Tesla's chart": in the floating panel (a side panel can't open without a click), or in the side panel when
  // it's already open. Questions ("what's this article saying?") go to Show me, on this page.
  const showChartRef = useRef<(symbol: string) => void>(() => {});
  const askRef = useRef<(question: string) => void>(() => {});
  const answerOwnChartOffer = useRef<(yes: boolean) => boolean>(() => false);
  /** TradingView's chart page asked which range (or which chart): a said or typed answer to it. */
  const answerChartAsk = useRef<(said: string) => boolean>(() => false);
  /** This tab's answers to that question, by chart (lib/chartAsk.ts): asked once per chart. */
  const chartAnswers = useRef(new ChartAnswers());
  const assistant = useAssistant({
    context: () => voiceContext.current(),
    onYesNo: (yes) => answerOwnChartOffer.current(yes),
    onAnswer: (said) => answerChartAsk.current(said),
    onChart: (symbol) => showChartRef.current(symbol),
    onAsk: (question) => askRef.current(question),
    onTestDrawing: () => void testDrawingRef.current(),
  });
  const testDrawingRef = useRef<() => Promise<void>>(async () => {});
  const preread = useRef<() => void>(() => {});
  const lastSelection = useRef<Range | null>(null);
  useEffect(() => {
    const onSelection = () => {
      const sel = document.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed && document.body.contains(sel.anchorNode)) lastSelection.current = sel.getRangeAt(0).cloneRange();
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);
  const [mentions, setMentions] = useState<Mention[]>(underliner.current());
  /** This page, and the sentence around the company's first underline, for the headline journal. */
  const pageContextFor = (symbol: string): PageContext => capturePage(document, underliner.current().find((m) => m.symbol === symbol)?.range ?? null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [openedByKeyboard, setOpenedByKeyboard] = useState(false);
  const [docked, setDocked] = useState(false);
  /** This browser has a side panel Glance can open (false in Arc): without one, Glance stays a floating panel. */
  const [canDock, setCanDock] = useState(true);
  useEffect(() => {
    void send<boolean>({ kind: "panel:supported" }).then(
      (ok) => setCanDock(ok !== false),
      () => {},
    );
  }, []);
  /** The float <-> dock movement in progress, if any (components/DockTransition.tsx). */
  const [dockAnim, setDockAnim] = useState<null | "dock" | "undock">(null);
  const wasDocked = useRef(false);
  /** Docking waits for beat 1 (the open panel draining into the orb) before the orb pours off (beat 2). */
  const dockAfterClose = useRef(false);
  const [pos, setPos] = useState<OrbPosition>({ right: 24, bottom: 24 });
  const [hover, setHover] = useState<{ symbol: string; rect: DOMRect; range: Range } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  const pointerInCard = useRef(false);
  /** Once the reader clicks or types in the hover card it stays open (its content can resize under the pointer). */
  const cardPinned = useRef(false);
  const orbRef = useRef<HTMLButtonElement>(null);
  /** Option+V is held on this page while docked: its release goes to the side panel too. */
  const heldForPanel = useRef(false);

  const companies = useMemo(() => companiesFrom(mentions, g.catalog), [mentions, g.catalog]);
  const companiesLatest = companies;
  const companiesRef = useRef<PageCompany[]>([]);
  const host = location.hostname.replace(/^www\./, "");
  // What the voice API may use to understand a command: this page and the companies found on it.
  voiceContext.current = () => ({
    host,
    companies: companies.map((c) => ({ symbol: c.symbol, mentions: c.mentions })),
    pageStock: pageStock(document, g.catalog.map((s) => s.symbol)),
  });

  useEffect(() => underliner.onChange(setMentions), [underliner]);

  // ---- Show me ---------------------------------------------------------------------------------------------------
  // Drawings live in an SVG inside our shadow root; the orb flies to what's being talked about, then home.
  const layerRef = useRef<HTMLDivElement>(null);
  const drawings = useRef<ShowDrawings | null>(null);
  const showRun = useRef<ShowMeRun | null>(null);
  /** "Switch the chart to candles to see it clearly." is said once a page. */
  const lineNoteSaid = useRef(false);
  const [flyRange, setFlyRange] = useState<Range | null>(null);
  const [flyPos, setFlyPos] = useState<OrbPosition | null>(null);
  const [orbFlying, setOrbFlying] = useState(false);
  useEffect(() => {
    if (!layerRef.current) return;
    const d = new ShowDrawings(layerRef.current);
    drawings.current = d;
    return () => d.destroy();
  }, []);
  // The orb follows its words while the page scrolls them into view; home again when the reply ends.
  useEffect(() => {
    if (!flyRange) {
      setFlyPos(null);
      const t = setTimeout(() => setOrbFlying(false), 700);
      return () => clearTimeout(t);
    }
    setOrbFlying(true);
    let frame = 0;
    const place = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setFlyPos(orbBeside(flyRange.getBoundingClientRect()));
      });
    };
    place();
    window.addEventListener("scroll", place, { passive: true, capture: true });
    window.addEventListener("resize", place, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [flyRange]);

  const showChart = useCallback(
    (symbol: string, range?: ChartRange) => {
      if (docked) {
        void requestCard({ kind: "chart", symbol, ...(range ? { range } : {}) });
        return;
      }
      // Already showing this stock on this range: keep it (its drawings are about to arrive).
      const open = chartAnnotations.showing;
      if (open?.symbol === symbol && (!range || open.range === range)) return;
      assistant.setCard({ kind: "chart", symbol, key: Date.now(), ...(range ? { range } : {}) });
      setPanelOpen(true);
    },
    [docked, assistant],
  );
  /** The visible figures listed with the last Show me question, for [BOX_FIGURE:n]. */
  const figureElements = useRef<Element[]>([]);
  /** The page as read on Option+V key down, so a question's context is ready by the release. */
  const prereadPage = useRef<{ at: number; page: ReturnType<typeof readPage>; elements: Element[] } | null>(null);
  const readPageNow = () => during("DOM scan", () => {
    const { figures, elements } = listFigures(document);
    figureElements.current = elements;
    return { at: Date.now(), page: readPage(document, { companies: companiesRef.current.map((c) => c.symbol), figures }), elements };
  });
  preread.current = () => {
    try {
      prereadPage.current = readPageNow();
    } catch {
      prereadPage.current = null;
    }
  };
  showChartRef.current = showChart;

  // ---- A chart on someone else's page: Glance's marks on it (never Glance's own chart over it) ------------------------
  const chartLayerRef = useRef<ChartLayer | null>(null);
  useEffect(() => () => chartLayerRef.current?.close(), []);
  /** Rule 3's question is open ("Want me to pull up my own?"): a yes shows Glance's own chart. */
  const ownChartOffer = useRef<{ symbol: string; range: ChartRange } | null>(null);
  /** Glance's own chart, docked beside the panel and never over a page chart (only when asked for). */
  const [ownChart, setOwnChart] = useState<{ symbol: string; range?: ChartRange; box: Box } | null>(null);
  const showOwnChart = useCallback(
    (symbol: string, range: ChartRange | undefined, why: string) => {
      ownChartOffer.current = null;
      const pageCharts = findChartCandidates(document, window).map((c) => c.box);
      if (docked || pageCharts.length === 0) {
        // In the side panel, or on a page with no chart of its own: Glance's usual chart card.
        console.info(`[glance] chart own: ${symbol} shown (${why}; ${docked ? "in the side panel" : "no chart on this page"})`);
        return showChart(symbol, range);
      }
      const panelEl = layerRef.current?.querySelector(".g-panel.is-shown");
      const pr = panelEl?.getBoundingClientRect();
      const panel = pr && pr.width > 0 ? { x: pr.left, y: pr.top, width: pr.width, height: pr.height } : null;
      const box = placeOwnChart(panel, { width: window.innerWidth, height: window.innerHeight }, pageCharts);
      if (!box) {
        console.info(`[glance] chart own: ${symbol} not shown (${why}; no room beside the panel clear of the page's chart)`);
        return g.setOrb({ state: "idle", line: LINES.noRoomForChart, meta: "" });
      }
      console.info(`[glance] chart own: ${symbol} shown beside the panel (${why})`);
      setOwnChart({ symbol, range, box });
    },
    [docked, showChart, g],
  );

  /**
   * Show me, given the page chart it's about (or none): the reply's chart tags go onto that chart (calibrated) or onto
   * the lens, and Glance's own panel chart isn't opened. Marks clear 6 seconds after the reply, or on Escape.
   */
  const startShowMe = useCallback(
    (question: string, onConsole: boolean, session: PageChartSession | null) => {
      showRun.current = runShowMe(question, {
        // Read on key down (while the user is still talking), else now.
        readPage: () => {
          const ready = prereadPage.current;
          prereadPage.current = null;
          if (ready && Date.now() - ready.at < 20_000) {
            figureElements.current = ready.elements;
            return ready.page;
          }
          return readPageNow().page;
        },
        askStream,
        speakParts: (h) => speakParts(g.voiceReplies, h),
        // "Explain this chart" on the page's own chart: one more sentence, on its most recent strong candle formation.
        afterword:
          session && explainsChart(question)
            ? () => {
                const s = strongPatternSentence({ points: session.data.points, series: session.series, prepost: Boolean(session.candles.prepost) });
                if (s) console.info(`[glance] candles ${JSON.stringify(question.slice(0, 60))}: strong pattern ${s.mark?.label ?? "?"}`);
                return s ? { text: s.text, draw: () => s.mark && session.markPattern(s.mark) } : null;
              }
            : undefined,
        surface: onConsole ? "console" : "page",
        capture: () => send<string | null>({ kind: "capture:tab" }).then((u) => u ?? null),
        downscale: downscaleJpeg,
        ask: (body) => api.showme(body),
        speak: (text, h) => speak(text, g.voiceReplies, h),
        hush,
        findQuote: (quote) => findQuote(document.body, quote),
        reveal: (range) => void revealRange(range),
        draw: (kind, range) => drawings.current?.draw(kind, range) ?? false,
        drawArrow: (from, to) => drawings.current?.drawArrow(from, to) ?? false,
        drawFigure: (n) => {
          const el = figureElements.current[n - 1];
          if (!el) return false;
          el.scrollIntoView?.({ block: "center", behavior: "smooth" });
          return drawings.current?.drawFigure(el) ?? false;
        },
        point: setFlyRange,
        // A chart the answer opens is Glance's own: docked beside the panel, never over the page's chart.
        chart: session ? () => {} : (symbol: string, range?: ChartRange) => showOwnChart(symbol, range, "the answer opened it"),
        // On a page chart: through its calibration, or on the lens. Docked, Glance's chart is in the side panel.
        annotate: (a) =>
          session ? session.annotate(a) : docked ? void send({ kind: "chart:annotate", annotation: a }).catch(() => {}) : chartAnnotations.annotate(a),
        openChart: () => (session ? { symbol: session.symbol, range: session.range } : chartAnnotations.showing),
        pageChart: () =>
          session
            ? { symbol: session.symbol, range: session.range, site: session.site, drawOn: session.drawOn, method: session.method, reason: session.reason, forced: session.forced, candles: session.candles }
            : null,
        portfolio: () => {
          if (docked) void requestCard({ kind: "portfolio" });
          else assistant.setCard({ kind: "portfolio", key: Date.now() });
        },
        vault: () => (/^0x[0-9a-fA-F]{40}$/.test(g.vaultAddress) ? g.vaultAddress : undefined),
        glanceKey: () => g.shortcuts?.glance || keyLabel(g.glanceKey),
        say: (line, state, note) => g.setOrb({ state, line, meta: note ?? (onConsole ? "Show me · on the console" : "Show me") }),
        done: (cancelled) => {
          // Finished: the marks stay, on the page and on the chart (lib/markLife.ts); cancelled, they all go.
          afterAnswer(cancelled, { clearPage: () => drawings.current?.clear(), clearCharts: () => chartAnnotations.clear(), closeLayer: () => session?.layer.close() });
          // An explanation of the page's chart always marks it: the computed defaults when the answer mentioned none.
          if (session && !cancelled && session.annotated === 0) for (const a of defaultMarks(session.facts, session.symbol)) session.annotate(a);
          // One log line per chart request, once its marks are drawn (they come in at most every 400ms).
          if (session) setTimeout(() => console.info(chartPathLine(session, question, { marks: session.layer.drawn })), 3_000);
        },
      });
    },
    [g, docked, assistant, showChart, showOwnChart],
  );

  /**
   * An answer written in code (candle questions: lib/candleAnswer.ts), spoken sentence by sentence with each one's mark
   * drawn on the page's chart as its sentence starts. Cancelled like a Show me answer (the next question, Escape).
   */
  const answerInCode = useCallback(
    (question: string, sentences: CandleSentence[], session: PageChartSession | null) => {
      const text = sentences.map((s) => s.text).join(" ");
      const meta = session ? "Chart lens" : "";
      const marks = sentences.map((s) => s.mark ?? null);
      const drawn = new Set<number>();
      const draw = (i: number) => {
        const m = marks[i];
        if (!m || !session || drawn.has(i)) return;
        drawn.add(i);
        session.markPattern(m);
      };
      g.setOrb({ state: "speaking", line: text, meta });
      let cancelled = false;
      const voice = speakParts(g.voiceReplies, { onPart: (i) => !cancelled && draw(i) });
      sentences.forEach((s, i) => {
        if (voice.push(s.text) === null) draw(i); // no voice: its mark at once
      });
      voice.end();
      const finished = voice.result.then((outcome) => {
        if (cancelled) return;
        // No voice (off, resting, unavailable): every mark, with the text on screen. A cut keeps what was said.
        if (outcome !== "ended" && outcome !== "cut") marks.forEach((_, i) => draw(i));
        g.setOrb({ state: "idle", line: text, meta: outcome === "cut" ? CUT_NOTE : meta });
        if (session) {
          const found = sentences.flatMap((s) => (s.mark ? [s.mark.label] : []));
          setTimeout(() => console.info(`[glance] candles ${JSON.stringify(question.slice(0, 60))}: site=${session.site} symbol=${session.symbol} range=${session.range} series=${session.series ?? "unknown"} found=${JSON.stringify(found)} marks=${session.layer.drawn}`), 1_500);
        }
      });
      showRun.current = {
        finished,
        cancel() {
          cancelled = true;
          hush();
        },
      };
    },
    [g],
  );

  const ask = useCallback(
    (question: string, lens: { confirmed?: { symbol: string; range: ChartRange } } = {}) => {
      showRun.current?.cancel();
      answerChartAsk.current = () => false;
      // The next chart question: the last one's marks go.
      chartLayerRef.current?.close();
      ownChartOffer.current = null;
      const onConsole = (() => {
        try {
          return Boolean(g.consoleUrl) && new URL(g.consoleUrl).origin === location.origin;
        } catch {
          return false;
        }
      })();
      const named = companiesInText(question, g.catalog)[0] ?? null;
      // Candle questions: answered in code (the detector and the explainer), never by the model.
      const candle = candleIntent(question);
      if (candle?.kind === "explain") return answerInCode(question, explainerAnswer(candle.id), null);
      if (candle && !onConsole && findChartCandidates(document, window).length === 0) return answerInCode(question, [{ text: NO_CHART_FOR_CANDLES }], null);
      // "Show me your chart": Glance's own, only on this explicit request (docked, never over the page's chart).
      if (!onConsole && wantsOwnChart(question)) {
        const own = named ?? pageStock(document, g.catalog.map((s) => s.symbol))?.symbol ?? companiesRef.current[0]?.symbol ?? null;
        if (own) return showOwnChart(own, undefined, "asked for Glance's chart");
      }
      if (!onConsole && !lens.confirmed) {
        // Which chart the question is about: the page's (any US stock), or Glance's own. One log line either way.
        const symbols = g.catalog.map((s) => s.symbol);
        const route = candle
          ? { route: "page" as const, reason: "a candle question about this chart" }
          : chooseChartRoute(question, { hasChart: findChartCandidates(document, window).length > 0, pageSymbol: pageStock(document, symbols)?.symbol ?? null, named });
        if (route.route === "glance") console.info(`[glance] chart ${JSON.stringify(question.slice(0, 60))}: Glance's own chart (${route.reason})`);
        if (route.route !== "page") return startShowMe(question, onConsole, null);
      }
      if (onConsole) return startShowMe(question, onConsole, null);
      void (async () => {
        g.setOrb({ state: "thinking", line: "Looking at this chart…", meta: "Chart lens" });
        const aliases = Object.fromEntries(g.catalog.map((s) => [s.symbol, [s.name, ...s.aliases]]));
        const prep = await preparePageChart(
          {
            doc: document,
            win: window,
            symbols: g.catalog.map((s) => s.symbol),
            aliases,
            named,
            capture: () => send<string | null>({ kind: "capture:tab" }).then((u) => u ?? null, () => null),
            vision: (img) =>
              api.calibrateChart(img).then((r) => (r.ok ? r.data : r.code === "VISION_DAILY_LIMIT" ? { limit: "today's chart readings are used up" } : null)),
            facts: (symbol, range, candles) => api.chartFacts([symbol], range, undefined, { market: true, ...candles }).then((r) => (r.ok ? (r.data.facts[0] ?? null) : null)),
            marketCandles: (symbol, range, opts) => api.marketCandles(symbol, range, opts).then((r) => (r.ok && r.data.points.length > 1 ? r.data : null)),
            openLayer: (el, cal, at, priceAt, pricesBetween, dots, range) => {
              chartLayerRef.current?.close();
              const l = new ChartLayer(layerRef.current!, el, cal, at, priceAt, pricesBetween, {
                dots,
                range,
                rangeNow: () => (isTradingViewChartPage(location) ? readTradingViewChart(document).range : selectedRange(el)),
                onClose: () => {
                  if (chartLayerRef.current === l) chartLayerRef.current = null;
                },
              });
              chartLayerRef.current = l;
              return l;
            },
            showDots: () => safely(() => calibrationDots.getValue(), Promise.resolve(false)),
            log: (l) => console.info(l),
            answers: chartAnswers.current,
          },
          lens,
        );
        if (prep.kind !== "ready") console.info(chartPathLine(prep, question));
        const offer = (line: string, options: Array<{ label: string; run(): void }>) => {
          g.setOrb({ state: "idle", line, meta: "Chart lens" });
          assistant.setCard({ kind: "choice", key: Date.now(), question: line, options });
          setPanelOpen(true);
        };
        switch (prep.kind) {
          case "none":
            return startShowMe(question, false, null); // no chart here after all: an ordinary answer
          case "unavailable":
            return g.setOrb({ state: "idle", line: prep.message, meta: "Chart lens" });
          case "ask": {
            if (prep.key && prep.symbol) {
              // TradingView's chart page: asked once. The answer is used now, and remembered for this chart.
              const symbol = prep.symbol;
              const key = prep.key;
              const answer = (range: ChartRange) => {
                answerChartAsk.current = () => false;
                assistant.setCard(null);
                chartAnswers.current.set(key, { symbol, range });
                ask(question, { confirmed: { symbol, range } });
              };
              const choices = prep.choices ?? [];
              answerChartAsk.current = (said) => {
                const range = choices.length ? rangeFromAnswer(said) : /^(yes|yeah|yep|sure|ok|okay)[.!]?$/i.test(said.trim()) ? prep.range : null;
                if (range === null || (choices.length && !choices.includes(range))) return false;
                answer(range);
                return true;
              };
              const options = choices.length ? choices.map((r) => ({ label: RANGE_BUTTON[r as keyof typeof RANGE_BUTTON], run: () => answer(r) })) : [{ label: "Yes", run: () => answer(prep.range) }, { label: "No", run: () => ((answerChartAsk.current = () => false), g.setOrb({ state: "idle", line: "Okay. Tell me the stock and range, like “explain Tesla's 5 day chart”.", meta: "" })) }];
              return offer(prep.question, options);
            }
            // Unsure which chart or stock: one short question, never a guess.
            const choices = prep.symbol
              ? [{ label: "Yes", run: () => ask(question, { confirmed: { symbol: prep.symbol!, range: prep.range } }) }]
              : companiesRef.current.slice(0, 3).map((c) => ({ label: c.symbol, run: () => ask(question, { confirmed: { symbol: c.symbol, range: prep.range } }) }));
            return offer(prep.question, [...choices, { label: "No", run: () => g.setOrb({ state: "idle", line: "Okay. Tell me the stock and range, like “explain Tesla's 5 day chart”.", meta: "" }) }]);
          }
          case "cant-calibrate": {
            // Rule 3: nothing drawn on the page; Glance's own chart only if the user says yes.
            ownChartOffer.current = { symbol: prep.symbol, range: prep.range };
            offer(LINES.cantLineUp, [
              { label: "Yes, pull up yours", run: () => showOwnChart(prep.symbol, prep.range, "yes to rule 3") },
              { label: "No", run: () => ((ownChartOffer.current = null), g.setOrb({ state: "idle", line: "Okay.", meta: "" })) },
            ]);
            return void speak(LINES.cantLineUp, g.voiceReplies);
          }
          case "ready":
            if (candle) {
              const sentences = candleAnswer(candle, { points: prep.data.points, series: prep.series, prepost: Boolean(prep.candles.prepost) }, lineNoteSaid.current);
              if (prep.series === "line") lineNoteSaid.current = true;
              return answerInCode(question, sentences, prep);
            }
            return startShowMe(question, false, prep);
        }
      })();
    },
    [g, assistant, startShowMe, showOwnChart, answerInCode],
  );
  askRef.current = ask;
  /** A spoken or typed "yes" / "no" to rule 3's question. True when there was one to answer. */
  answerOwnChartOffer.current = (yes: boolean) => {
    const offer = ownChartOffer.current;
    if (!offer) return false;
    ownChartOffer.current = null;
    if (yes) showOwnChart(offer.symbol, offer.range, "yes to rule 3");
    else g.setOrb({ state: "idle", line: "Okay.", meta: "" });
    return true;
  };
  // Developer check: every shape on the selection (dev builds, or developer tools on in settings). Typing in the panel
  // can take the page's selection away, so the last one on the page is remembered.
  testDrawingRef.current = async () => {
    const on = import.meta.env.DEV || (await safely(() => devTools.getValue(), Promise.resolve(false)));
    if (!on) return g.setOrb({ state: "idle", line: "Turn on developer tools in settings to test drawing.", meta: "" });
    const range = lastSelection.current;
    if (!range || range.collapsed) return g.setOrb({ state: "idle", line: "Select some text on the page, then type “glance test drawing” again.", meta: "" });
    drawings.current?.clear();
    const drawn = drawings.current?.drawTest(range, nextSentence(range)) ?? [];
    g.setOrb({ state: "idle", line: `Drew ${drawn.join(", ").toLowerCase()} on your selection.`, meta: "Test drawing" });
    drawings.current?.fadeLater(8_000);
  };
  companiesRef.current = companiesLatest;
  // One quiet-time frame sample: if this page can't hold frame rate on its own, skip the idle breathing pulse.
  useEffect(() => {
    const t = setTimeout(() => void sampleFrames().then(reportIdleFrames), 4_000);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!hover) cardPinned.current = false;
  }, [hover]);
  useEffect(() => {
    void safely(() => orbPosition.getValue(), Promise.resolve(pos)).then(setPos);
    const unwatch = safely(() => orbPosition.watch(setPos), () => {});
    return () => safely(unwatch, undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The refresh notice appears where the orb was, if Glance is reloaded under this page.
  useEffect(() => rememberOrbAnchor(pos), [pos]);

  // Docked state: ask once, then follow the background's broadcasts. Answer the side panel's questions.
  useEffect(() => {
    void send({ kind: "panel:isOpen" })
      .then((open) => {
        wasDocked.current = Boolean(open);
        setDocked(Boolean(open));
      })
      .catch(() => {});
    const onMessage = (msg: Message): Promise<PageMatchesReply> | undefined => {
      if (msg.kind === "panel:changed") {
        // The side panel just closed on a page that was docked: the orb flows back in from that edge.
        if (!msg.open && wasDocked.current) setDockAnim("undock");
        if (msg.open) setDockAnim((a) => (a === "undock" ? null : a));
        wasDocked.current = msg.open;
        setDocked(msg.open);
      }
      if ((msg.kind === "page:matches" || msg.kind === "page:scan") && gatedRef.current !== false) return Promise.resolve({ host, companies: [] });
      if (msg.kind === "page:matches") return Promise.resolve({ host, companies: companiesFrom(underliner.current(), g.catalog), pageStock: pageStock(document, g.catalog.map((s) => s.symbol)) });
      if (msg.kind === "page:scan") return underliner.glance().then(() => ({ host, companies: companiesFrom(underliner.current(), g.catalog) }));
      if (msg.kind === "page:reveal") underliner.reveal(msg.symbol);
      // Docked: a question asked in the side panel, answered here (this page is what it's about).
      if (msg.kind === "page:ask") askRef.current(msg.question);
      // The side panel is placing a buy: this page, and the sentence that named the company (kept in this browser).
      if (msg.kind === "page:context") return Promise.resolve(pageContextFor(msg.symbol)) as never;
      // A keyboard shortcut, as a browser command (lib/commandTalk.ts for talk's press / press-again).
      if (msg.kind === "command") {
        if (msg.command === "glance") void glanceRef.current();
        else talkCommand.current.press();
      }
      return undefined;
    };
    safely(() => browser.runtime.onMessage.addListener(onMessage), undefined);
    return () => safely(() => browser.runtime.onMessage.removeListener(onMessage), undefined);
  }, [host, underliner, g.catalog]);

  const gatedRef = useRef<boolean | null>(null);
  gatedRef.current = g.gated;
  // Browser commands arrive in the listener above; these refs always hold the latest glance and talk handlers.
  const glanceRef = useRef<() => Promise<void>>(async () => {});
  const talkHandlers = useRef({ start: () => {}, stop: () => {} });
  const talkCommand = useRef(
    createCommandTalk({
      start: () => talkHandlers.current.start(),
      stop: () => talkHandlers.current.stop(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    }),
  );

  // ---- glance (Option+G, tap) --------------------------------------------------------------------------------
  const glance = useCallback(async () => {
    // Mid dock or undock: the orb isn't back yet, so nothing opens until it has reformed.
    if (dockAnim) return;
    // Not set up yet: the shortcut opens the setup card, and nothing is scanned.
    if (g.gated !== false) {
      setPanelOpen(true);
      return;
    }
    await underliner.glance();
    const found = companiesFrom(underliner.current(), g.catalog);
    if (docked) {
      void send({ kind: "assistant:glance", reply: { host, companies: found } } satisfies AssistantMessage).catch(() => {});
      return;
    }
    if (!panelOpen) soundCue.current.request("open");
    setPanelOpen(true);
    g.setOrb({ state: "idle", line: glanceLine(host, found), meta: `Hold ${keyLabel(g.voiceKey)} to ask about them` });
  }, [underliner, g, docked, host, dockAnim, panelOpen]);

  // ---- voice (Option+V, hold) --------------------------------------------------------------------------------
  const startTalking = useCallback(() => {
    if (dockAnim) return;
    // Not set up yet: no voice; the setup card instead.
    if (g.gated !== false) {
      setPanelOpen(true);
      return;
    }
    if (docked) {
      // The side panel owns the conversation (and the voice session, recorded in the offscreen document either way).
      heldForPanel.current = true;
      void send({ kind: "assistant:hold", down: true } satisfies AssistantMessage).catch(() => {});
      setTimeout(() => preread.current(), 0); // a question about the page will be answered here
      return;
    }
    setPanelOpen(true);
    assistant.talkDown();
    // While they talk: read the page now, so if it's a question about it, the context is ready at the release.
    setTimeout(() => preread.current(), 0);
  }, [docked, assistant, dockAnim, g.gated]);

  const stopTalking = useCallback(() => {
    if (heldForPanel.current) {
      heldForPanel.current = false;
      void send({ kind: "assistant:hold", down: false } satisfies AssistantMessage).catch(() => {});
    } else assistant.talkUp();
  }, [assistant]);

  const closePanel = useCallback(() => {
    setHover(null);
    if (!panelOpen) return;
    soundCue.current.request("close");
    setPanelOpen(false);
    orbRef.current?.focus();
  }, [panelOpen]);

  // Capture phase, so the keys work even while focus is inside our shadow root, and the page never sees them.
  glanceRef.current = glance;
  talkHandlers.current = { start: startTalking, stop: stopTalking };
  // Listening ended some other way (Escape, silence, the panel): the next talk command starts afresh.
  useEffect(() => {
    if (!assistant.listening) talkCommand.current.reset();
  }, [assistant.listening]);
  useHotkeys(
    { glance: g.glanceKey, voice: g.voiceKey },
    {
      onGlance: () => void glance(),
      onVoiceStart: startTalking,
      onVoiceEnd: stopTalking,
      // Escape stops Show me first (voice, drawings, the orb comes home); pressed again, it closes the panel.
      onEscape: () => {
        // Listening (conversation mode keeps the microphone open until you finish): Escape cancels it, sending nothing.
        if (assistant.cancelListening()) return;
        const run = showRun.current;
        showRun.current = null;
        if (run && (flyRange || (drawings.current?.count ?? 0) > 0 || g.orb.state !== "idle")) {
          run.cancel();
          return;
        }
        // The marks on the page's chart stay until Escape; then Glance's own chart; then the panel.
        if (chartLayerRef.current?.isOpen) {
          chartLayerRef.current.close();
          return;
        }
        if (ownChart) {
          setOwnChart(null);
          return;
        }
        drawings.current?.clear();
        chartAnnotations.clear();
        closePanel();
      },
    },
    { capture: true },
  );

  // While the panel is open a command is likely: keep the API's provider connections warm (it lets them lapse after
  // a minute unused), so Option+V doesn't pay the connection handshakes to Deepgram. The opening may also open one
  // AssemblyAI session (billed, held 5s; ASSEMBLYAI_WARM=panel); the 45s refresh never does.
  useEffect(() => {
    if (!panelOpen) return;
    warmVoice(true);
    const t = setInterval(() => warmVoice(), 45_000);
    return () => clearInterval(t);
  }, [panelOpen]);

  // ---- first run: the welcome (once, shown and said), then the three-step tour (once, skippable) ----------------
  const [onboard, setOnboard] = useState<{ phase: "welcome"; line: string } | { phase: "tour"; step: number } | null>(null);
  const reducedMotion = prefersReducedMotion();
  useEffect(() => {
    // The welcome and the tour wait until Glance is set up (the gate has opened), then run once each, in the tab the
    // user is looking at (its window's active tab): with Glance on every open page, a background tab mustn't claim it.
    if (g.gated !== false) return;
    let started = false;
    let checking = false;
    const start = async () => {
      if (started || checking || document.visibilityState !== "visible") return;
      checking = true;
      const active = await send<boolean>({ kind: "tab:active" }).catch(() => false);
      checking = false;
      if (!active || started) return;
      started = true;
      window.removeEventListener("focus", start);
      document.removeEventListener("visibilitychange", start);
      void safely(async () => {
        const [wasGreeted, toured] = await Promise.all([greeted.getValue(), tourDone.getValue()]);
        const show = firstRun(wasGreeted, toured);
        if (show === "welcome") {
          await greeted.setValue(true);
          const line = GREETING(keyLabel(g.glanceKey), keyLabel(g.voiceKey));
          // Setup just finished (its card may still be open): make way for the welcome by the orb.
          setPanelOpen(false);
          setOnboard({ phase: "welcome", line });
          g.setOrb({ state: "idle", line, meta: "Hello" });
          // Glance's own voice, pre-recorded for the default keys (only when voice replies are on).
          void speak(SPOKEN_GREETING(g.glanceKey.toUpperCase(), g.voiceKey.toUpperCase()), g.voiceReplies, {
            onStart: () => g.setOrb({ state: "speaking", line, meta: "Hello" }),
            onEnd: () => g.setOrb({ state: "idle", line, meta: "Hello" }),
          });
        } else if (show === "tour") setOnboard({ phase: "tour", step: 0 });
      }, Promise.resolve());
    };
    void start();
    window.addEventListener("focus", start);
    document.addEventListener("visibilitychange", start);
    return () => {
      window.removeEventListener("focus", start);
      document.removeEventListener("visibilitychange", start);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.gated]);

  // The hotkey tip by the orb: the first 3 page loads (once Glance is set up), 1.2s after load, for 6s; never again.
  // Not while the welcome or the tour is showing by the orb.
  const [tipShown, setTipShown] = useState(false);
  const onboardRef = useRef(onboard);
  onboardRef.current = onboard;
  useEffect(() => {
    if (g.gated !== false) return;
    let hide: number | undefined;
    const show = window.setTimeout(() => {
      if (onboardRef.current || document.visibilityState !== "visible") return;
      void takeHotkeyTip().then((yes) => {
        if (!yes) return;
        setTipShown(true);
        hide = window.setTimeout(() => setTipShown(false), 6_000);
      });
    }, 1_200);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [g.gated]);

  // Navigating away (a new URL, as single-page sites do it) takes the page's marks with it: they were about that page.
  useEffect(
    () =>
      watchNavigation(window, () => {
        drawings.current?.clear();
        chartAnnotations.clear();
      }),
    [],
  );

  // Underlines only once Glance is set up (and none again should it ever be gated).
  useEffect(() => {
    if (g.gated === false) underliner.start();
    else underliner.stop();
  }, [g.gated, underliner]);
  const endTour = () => {
    setOnboard(null);
    void safely(() => tourDone.setValue(true), Promise.resolve());
  };
  const steps = tourSteps(keyLabel(g.voiceKey));
  const orbAnchor = { left: window.innerWidth - pos.right - orbTokens.floating, top: window.innerHeight - pos.bottom - orbTokens.floating, width: orbTokens.floating, height: orbTokens.floating };
  const underlineAnchor = () => {
    const r = mentions[0]?.range.getBoundingClientRect();
    return r && r.width > 0 && r.bottom > 0 && r.top < window.innerHeight ? { left: r.left, top: r.top, width: r.width, height: r.height } : orbAnchor;
  };

  // "Getting started": hovered a company.
  useEffect(() => {
    if (hover) void tick("hover");
  }, [hover]);

  // A voice buy or price question opens the panel to show its card.
  useEffect(() => {
    if (assistant.card) setPanelOpen(true);
  }, [assistant.card]);

  // ---- hover card ----------------------------------------------------------------------------------------------
  useEffect(() => {
    let frame = 0;
    const onMove = (e: MouseEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const hit = underliner.hitTest(e.clientX, e.clientY);
        clearTimeout(hoverTimer.current);
        if (hit) {
          if (hover?.symbol === hit.symbol) return;
          hoverTimer.current = setTimeout(() => setHover({ symbol: hit.symbol, rect: hit.range.getBoundingClientRect(), range: hit.range }), HOVER_DWELL_MS);
        } else if (hover && !pointerInCard.current && !cardPinned.current) {
          hoverTimer.current = setTimeout(() => !pointerInCard.current && !cardPinned.current && setHover(null), HOVER_GRACE_MS);
        }
      });
    };
    // Busy sites fire scroll events without the reader scrolling (sticky headers, lazy loading). Keep the card anchored
    // to its words; close it only once they have left the screen and the pointer is not on the card.
    let scrollFrame = 0;
    const onScroll = () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        setHover((h) => {
          if (!h) return h;
          const rect = h.range.getBoundingClientRect();
          const offscreen = rect.bottom < 0 || rect.top > window.innerHeight || (rect.width === 0 && rect.height === 0);
          return offscreen && !pointerInCard.current && !cardPinned.current ? null : { ...h, rect };
        });
      });
    };
    document.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(scrollFrame);
    };
  }, [underliner, hover]);

  // ---- orb drag and click ----------------------------------------------------------------------------------------
  const drag = useRef<{ x: number; y: number; moved: boolean; start: OrbPosition; at: OrbPosition; t: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const orbMotion = useOrbMotion(orbRef, g.orb.state, { still: g.still, dragging });
  /** pointerup fires before click: remember a finished drag so its click doesn't also start talking. */
  const justDragged = useRef(false);
  const clamp = (p: OrbPosition): OrbPosition => ({
    right: Math.min(Math.max(p.right, 4), window.innerWidth - orbTokens.hitArea - 4),
    bottom: Math.min(Math.max(p.bottom, 4), window.innerHeight - orbTokens.hitArea - 4),
  });
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, moved: false, start: pos, at: pos, t: performance.now(), vx: 0, vy: 0 };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!d.moved) setDragging(true);
    d.moved = true;
    const next = clamp({ right: d.start.right - dx, bottom: d.start.bottom - dy });
    // The anchor jumps to the cursor; the orb itself trails it on a spring, a little behind.
    const sx = d.at.right - next.right;
    const sy = d.at.bottom - next.bottom;
    orbMotion.follow(sx, sy);
    const now = performance.now();
    const dt = Math.max(1, now - d.t) / 1000;
    // Smoothed pointer velocity, for the release jiggle.
    d.vx = d.vx * 0.6 + (sx / dt) * 0.4;
    d.vy = d.vy * 0.6 + (sy / dt) * 0.4;
    d.t = now;
    d.at = next;
    setPos(next);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    justDragged.current = Boolean(d?.moved);
    if (!d?.moved) return;
    setDragging(false);
    // A stale velocity (the pointer rested before letting go) shouldn't jiggle.
    const fresh = performance.now() - d.t < 80;
    orbMotion.release(fresh ? Math.hypot(d.vx, d.vy) : 0);
    void safely(() => orbPosition.setValue(pos), Promise.resolve());
  };
  /**
   * Docking: the orb drains off toward the window edge, and the side panel is requested as the liquid starts leaving
   * the screen (onPanelCue), so it appears just as the liquid goes. Chrome only opens a side panel from a user gesture;
   * the click's activation lasts seconds, and the cue comes about a quarter of a second after it.
   */
  const switchToDocked = () => {
    if (dockAnim) return;
    void safely(() => defaultMode.setValue("docked"), Promise.resolve());
    if (panelOpen) {
      // Beat 1: the panel drains back into the orb first; GooPanel's onClosed starts beat 2.
      dockAfterClose.current = true;
      setPanelOpen(false);
      assistant.setCard(null);
    } else {
      setDockAnim("dock");
    }
  };
  /** Chrome refused the side panel (no user gesture left, or no side panel support): the orb flows back instead. */
  const panelRefused = useRef(false);
  const requestSidePanel = () => {
    panelRefused.current = false;
    void send<boolean>({ kind: "panel:open" }).then(
      (ok) => {
        panelRefused.current = ok === false;
        if (ok === false) setCanDock(false);
      },
      () => (panelRefused.current = true),
    );
  };
  /** Clicking the orb docks Glance to the side panel. */
  const onOrbClick = () => {
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    if (assistant.listening) assistant.stopListening();
    // Not set up yet: the orb opens its setup card right here (docking comes once Glance is ready).
    // Not set up yet, or a browser with no side panel (Arc): the orb opens its floating panel right here.
    if (g.gated !== false || !canDock) {
      setPanelOpen((open) => !open);
      return;
    }
    switchToDocked();
  };
  /** Keyboard users: Enter or Space glances (opens the panel with what was found); the panel has the dock button. */
  const onOrbKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    setOpenedByKeyboard(true);
    if (panelOpen) closePanel();
    else void glance();
  };

  const { closed, freshestAgeSeconds } = marketClosed(g.health);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const orbLeftHalf = vw - pos.right - orbTokens.hitArea / 2 < vw / 2;
  const orbTopHalf = vh - pos.bottom - orbTokens.hitArea / 2 < vh / 2;
  const beside = orbLeftHalf ? { left: vw - pos.right - orbTokens.hitArea } : { right: pos.right };
  const panelPlacement = { ...beside, ...(orbTopHalf ? { top: vh - pos.bottom + 8 } : { bottom: pos.bottom + orbTokens.hitArea + 8 }) };

  return (
    <div className="g-layer" ref={layerRef}>
      {ownChart && (
        <div className="g-own-chart" style={{ left: ownChart.box.x, top: ownChart.box.y, width: ownChart.box.width, height: ownChart.box.height }} data-glance-own-chart="1">
          <StockChart key={`${ownChart.symbol}:${ownChart.range ?? ""}`} symbol={ownChart.symbol} initialRange={ownChart.range} onClose={() => setOwnChart(null)} mount={pageMount} />
        </div>
      )}
      {dockAnim && (
        <DockTransition
          key={dockAnim}
          kind={dockAnim}
          orb={orbDisc(pos, vw, vh)}
          onPanelCue={requestSidePanel}
          onDone={() => {
            const finished = dockAnim;
            if (finished === "dock" && panelRefused.current) {
              panelRefused.current = false;
              void safely(() => defaultMode.setValue("floating"), Promise.resolve());
              setDockAnim("undock");
              return;
            }
            // Undock: the orb has reformed (the curve's overshoot was its wobble); only now can it open again.
            setDockAnim(null);
          }}
        />
      )}
      {!docked && (
        <>
          {closed && !panelOpen && (
            <div className="g-float-badge" style={{ ...beside, ...(orbTopHalf ? { top: vh - pos.bottom + 6 } : { bottom: pos.bottom + orbTokens.hitArea + 6 }) }}>
              <WeekendBadge ageSeconds={freshestAgeSeconds} cap={g.vault?.limits.weekendCap ?? "25%"} />
            </div>
          )}

          <GooPanel
            open={panelOpen}
            orb={orbDisc(pos, vw, vh)}
            placement={panelPlacement}
            onLiquidStart={(dir) => {
              if (soundCue.current.take(dir)) sfx?.play(dir);
            }}
            onClosed={() => {
              if (!dockAfterClose.current) return;
              dockAfterClose.current = false;
              setDockAnim("dock"); // beat 2
            }}
          >
            <Panel
              layout="compact"
              assistant={assistant}
              host={host}
              companies={companies}
              onRevealCompany={(s) => underliner.reveal(s)}
              onSwitchMode={switchToDocked}
              canDock={canDock}
              onClose={() => {
                soundCue.current.request("close");
                setPanelOpen(false);
                assistant.setCard(null);
                // The x: the answer's marks go with it (the chart layer has its own x).
                showRun.current?.cancel();
                drawings.current?.clear();
                chartAnnotations.clear();
              }}
              autoFocusInput={openedByKeyboard}
              pageContext={pageContextFor}
              renderChart={(symbol, onClose, range) => <StockChart key={`${symbol}:${range ?? ""}`} symbol={symbol} initialRange={range} onClose={onClose} mount={pageMount} />}
            />
          </GooPanel>

          <button
            ref={orbRef}
            className={`g-orb-button${dockAnim ? " is-hidden" : ""}${orbFlying ? " is-flying" : ""}`}
            data-breathe={orbMotion.breathe || undefined}
            style={flyPos ? { right: flyPos.right, bottom: flyPos.bottom } : { right: pos.right, bottom: pos.bottom }}
            aria-label={`Glance: ${companies.length} companies found on this page. Click to dock to the side panel. Tap Option ${g.glanceKey} to glance, hold Option ${g.voiceKey} to talk.`}
            aria-expanded={panelOpen}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={onOrbClick}
            onKeyDown={onOrbKey}
          >
            <Orb state={g.orb.state} size={orbTokens.floating} markUrl={g.markUrl} />
          </button>
          {onboard?.phase === "welcome" && !panelOpen && (
            <Welcome line={onboard.line} anchor={orbAnchor} reducedMotion={reducedMotion} onTour={() => setOnboard({ phase: "tour", step: 0 })} onSkip={endTour} />
          )}
          {onboard?.phase === "tour" && !panelOpen && (
            <Tour
              step={onboard.step}
              total={steps.length}
              title={steps[onboard.step]!.title}
              anchor={steps[onboard.step]!.anchor === "underline" ? underlineAnchor() : orbAnchor}
              reducedMotion={reducedMotion}
              onNext={() => (onboard.step + 1 < steps.length ? setOnboard({ phase: "tour", step: onboard.step + 1 }) : endTour())}
              onSkip={endTour}
            />
          )}
          {tipShown && !panelOpen && !orbFlying && !onboard && (
            <span
              className="g-kbd"
              role="status"
              data-testid="hotkey-tip"
              style={{ position: "fixed", right: pos.right, bottom: pos.bottom + orbTokens.floating + 8, background: "var(--g-surface)", color: "var(--g-text)", pointerEvents: "none", animation: "g-in var(--g-panel) var(--g-ease)" }}
            >
              {hotkeyTip(keyLabel(g.glanceKey), keyLabel(g.voiceKey))}
            </span>
          )}
          {/* This browser's link ends within 3 days (or has ended): a small "Relink" above the orb (one signature). */}
          {g.relink.show && g.gated === false && !panelOpen && !orbFlying && (
            <button
              className="g-chip"
              style={{ position: "fixed", right: pos.right, bottom: pos.bottom + orbTokens.floating + 8, zIndex: 1, pointerEvents: "auto" }}
              title={relinkLine(g.relink)}
              onClick={g.openRelink}
            >
              Relink
            </button>
          )}
        </>
      )}

      {hover && (
        <div
          className="g-pop"
          style={placeCard(hover.rect)}
          onMouseEnter={() => {
            pointerInCard.current = true;
            clearTimeout(hoverTimer.current);
          }}
          onMouseLeave={() => {
            pointerInCard.current = false;
            if (!cardPinned.current) hoverTimer.current = setTimeout(() => !cardPinned.current && setHover(null), HOVER_GRACE_MS);
          }}
          onPointerDownCapture={() => (cardPinned.current = true)}
          onFocusCapture={() => (cardPinned.current = true)}
        >
          <CompanyCard key={hover.symbol} symbol={hover.symbol} variant="hover" onClose={() => setHover(null)} pageContext={() => capturePage(document, hover.range)} />
        </div>
      )}
    </div>
  );
}

/** Where the orb sits to point at words: just left of them (right of them near the left edge), on the viewport. */
export function orbBeside(rect: DOMRect | { left: number; right: number; top: number; height: number }, vw = window.innerWidth, vh = window.innerHeight): OrbPosition {
  const size = orbTokens.hitArea;
  const gap = 6;
  let left = rect.left - size - gap;
  if (left < 4) left = rect.right + gap;
  const top = rect.top + rect.height / 2 - size / 2;
  const right = Math.min(Math.max(vw - left - size, 4), vw - size - 4);
  const bottom = Math.min(Math.max(vh - top - size, 4), vh - size - 4);
  return { right, bottom };
}

/** Below the words if there is room, otherwise above; kept inside the viewport. */
function placeCard(rect: DOMRect): React.CSSProperties {
  const width = 332;
  const gap = 8;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  return rect.bottom + 360 < window.innerHeight ? { left, top: rect.bottom + gap } : { left, bottom: window.innerHeight - rect.top + gap };
}
