/**
 * The in-page Glance UI: a draggable orb, its compact panel (which melts out of the orb, components/GooPanel.tsx), the
 * hover card on underlined company names, and the weekend badge. Option+G (tap) glances at the page; Option+V (hold)
 * talks; clicking the orb docks Glance to the side panel. When the user has docked Glance and the side panel is open, the orb hides entirely (it must never
 * cover the page's own controls) and speech started here is handed to the side panel. Speech itself never runs in the
 * page: lib/voiceClient runs it in Glance's offscreen document.
 */
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
import type { Message, PageMatchesReply } from "../../lib/messages";
import { defaultMode, orbPosition, type OrbPosition } from "../../lib/settings";
import { orb as orbTokens } from "../../lib/tokens";
import type { Mention, Underliner } from "../../lib/underline";
import { rememberOrbAnchor } from "../../lib/updatedNotice";
import { startVoice, type VoiceSession } from "../../lib/voiceClient";

const HOVER_DWELL_MS = 300;
const HOVER_GRACE_MS = 250;
const DRAG_THRESHOLD = 4;

export function App({ underliner }: { underliner: Underliner }) {
  return (
    <GlanceProvider idleLine="">
      <div className="g-root">
        <Floating underliner={underliner} />
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

function Floating({ underliner }: { underliner: Underliner }) {
  const g = useGlance();
  const assistant = useAssistant();
  const [mentions, setMentions] = useState<Mention[]>(underliner.current());
  const [panelOpen, setPanelOpen] = useState(false);
  const [openedByKeyboard, setOpenedByKeyboard] = useState(false);
  const [docked, setDocked] = useState(false);
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
  const dockedListener = useRef<VoiceSession | null>(null);

  const companies = useMemo(() => companiesFrom(mentions, g.catalog), [mentions, g.catalog]);
  const host = location.hostname.replace(/^www\./, "");

  useEffect(() => underliner.onChange(setMentions), [underliner]);
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
      if (msg.kind === "page:matches") return Promise.resolve({ host, companies: companiesFrom(underliner.current(), g.catalog) });
      if (msg.kind === "page:scan") return underliner.scan().then(() => ({ host, companies: companiesFrom(underliner.current(), g.catalog) }));
      if (msg.kind === "page:reveal") underliner.reveal(msg.symbol);
      return undefined;
    };
    safely(() => browser.runtime.onMessage.addListener(onMessage), undefined);
    return () => safely(() => browser.runtime.onMessage.removeListener(onMessage), undefined);
  }, [host, underliner, g.catalog]);

  // ---- glance (Option+G, tap) --------------------------------------------------------------------------------
  const glance = useCallback(async () => {
    // Mid dock or undock: the orb isn't back yet, so nothing opens until it has reformed.
    if (dockAnim) return;
    await underliner.scan();
    const found = companiesFrom(underliner.current(), g.catalog);
    if (docked) {
      void send({ kind: "assistant:glance", reply: { host, companies: found } } satisfies AssistantMessage).catch(() => {});
      return;
    }
    setPanelOpen(true);
    g.setOrb({ state: "idle", line: glanceLine(host, found), meta: `Hold ${keyLabel(g.voiceKey)} to ask about them` });
  }, [underliner, g, docked, host, dockAnim]);

  // ---- voice (Option+V, hold) --------------------------------------------------------------------------------
  const startTalking = useCallback(() => {
    if (dockAnim) return;
    if (docked) {
      // The side panel owns the conversation; listen (in the offscreen document) and hand the words over.
      if (dockedListener.current) return;
      const relay = (m: AssistantMessage) => void send(m).catch(() => {});
      relay({ kind: "assistant:listening", listening: true });
      let failed = false;
      let finalText = "";
      dockedListener.current = startVoice({
        onInterim: (text) => relay({ kind: "assistant:heard", text }),
        onFinal: (text) => {
          finalText = text;
        },
        onError: (code) => {
          failed = true;
          relay({ kind: "assistant:error", code });
        },
        onEnd: () => {
          dockedListener.current = null;
          if (!failed) relay({ kind: "assistant:run", text: finalText });
        },
      });
      return;
    }
    setPanelOpen(true);
    assistant.startListening();
  }, [docked, assistant, dockAnim]);

  const stopTalking = useCallback(() => {
    if (dockedListener.current) dockedListener.current.stop();
    else assistant.stopListening();
  }, [assistant]);

  const closePanel = useCallback(() => {
    setHover(null);
    if (!panelOpen) return;
    setPanelOpen(false);
    orbRef.current?.focus();
  }, [panelOpen]);

  // Capture phase, so the keys work even while focus is inside our shadow root, and the page never sees them.
  useHotkeys(
    { glance: g.glanceKey, voice: g.voiceKey },
    { onGlance: () => void glance(), onVoiceStart: startTalking, onVoiceEnd: stopTalking, onEscape: closePanel },
    { capture: true },
  );

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
      (ok) => (panelRefused.current = ok === false),
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
    <div className="g-layer">
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
              onClose={() => {
                setPanelOpen(false);
                assistant.setCard(null);
              }}
              autoFocusInput={openedByKeyboard}
            />
          </GooPanel>

          <button
            ref={orbRef}
            className={`g-orb-button${dockAnim ? " is-hidden" : ""}`}
            data-breathe={orbMotion.breathe || undefined}
            style={{ right: pos.right, bottom: pos.bottom }}
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
          <CompanyCard key={hover.symbol} symbol={hover.symbol} variant="hover" onClose={() => setHover(null)} />
        </div>
      )}
    </div>
  );
}

/** Below the words if there is room, otherwise above; kept inside the viewport. */
function placeCard(rect: DOMRect): React.CSSProperties {
  const width = 332;
  const gap = 8;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  return rect.bottom + 360 < window.innerHeight ? { left, top: rect.bottom + gap } : { left, bottom: window.innerHeight - rect.top + gap };
}
