/**
 * The Glance orb, built to design/Glance Foundations.html section 03: a black disc, a 1–2px state ring, then a 1.5px
 * black keyline, so it holds on any host page. Every state changes shape, not only hue:
 *
 *   idle       white eye on black
 *   listening  solid lime disc, pulsing ring, and a dotted waveform (thinking-orbs "listening", dark ink)
 *   thinking   lime arc orbiting a dotted cloud (thinking-orbs "working", lime ink); the eye steps aside
 *   speaking   lime ring, level bars
 *   success    lime disc with a check (held for 2s by the caller)
 *   blocked    amber ring and a shield: the vault said no
 *
 * The dotted motion comes from the thinking-orbs library (github.com/Jakubantalik/thinking-orbs, MIT), which renders
 * on a plain canvas, pauses when hidden, and shows a static frame under prefers-reduced-motion.
 */
import type { CSSProperties } from "react";
import { ThinkingOrb } from "thinking-orbs";

import { color, orb as orbTokens } from "../lib/tokens";

export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "success" | "blocked";

export const ORB_LABELS: Record<OrbState, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  success: "Done",
  blocked: "Held back",
};

interface Props {
  state: OrbState;
  size?: number;
  markUrl: string;
}

export function Orb({ state, size = orbTokens.floating, markUrl }: Props) {
  const style = { width: size, height: size, "--size": `${size}px`, "--mark-url": `url("${markUrl}")` } as CSSProperties;
  const dotsSize = size >= 48 ? 32 : 20;

  let inner: JSX.Element;
  switch (state) {
    case "listening":
      inner = <ThinkingOrb className="g-orb-dots" state="listening" size={dotsSize} theme="light" color={color.onLime} aria-hidden />;
      break;
    case "thinking":
      inner = <ThinkingOrb className="g-orb-dots" state="working" size={dotsSize} theme="dark" color={color.lime} aria-hidden />;
      break;
    case "speaking":
      inner = (
        <div className="g-orb-bars" aria-hidden>
          {[0, 0.15, 0.3, 0.45].map((d) => (
            <span key={d} style={{ animationDelay: `${d}s` }} />
          ))}
        </div>
      );
      break;
    case "success":
      inner = (
        <svg width={size * 0.44} height={size * 0.44} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--g-on-lime)" }} aria-hidden>
          <path d="M4 12.5l5 5L20 6.5" />
        </svg>
      );
      break;
    case "blocked":
      inner = <Shield size={size * 0.46} />;
      break;
    default:
      inner = <div className="g-orb-mark" aria-hidden />;
  }

  return (
    <div className="g-orb" data-state={state} style={style}>
      {state === "listening" && <div className="g-orb-pulse" aria-hidden />}
      {state === "thinking" && <div className="g-orb-arc" aria-hidden />}
      <div className="g-orb-disc">{inner}</div>
    </div>
  );
}

export function Shield({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" style={{ color: "var(--g-guard)" }} aria-hidden>
      <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z" />
      <path d="M8.5 12h7" />
    </svg>
  );
}
