/**
 * The Welcome page's spoken intro: nine lines in Glance's own voice, pre-recorded (public/intro/line-NN.mp3, made by
 * scripts/gen-intro-audio.ts), one caption at a time under the orb. No network during the intro.
 *
 * The sequencing is a small state machine, so it can be tested without audio:
 *   ready     waiting to start (on load it tries to play)
 *   blocked   the browser wouldn't play sound without a click: "Tap to meet Glance"
 *   playing   line `line` is being said (its caption shows); after it ends, a short pause, then the next
 *   end       "Set me up" and "Replay intro" (also where Skip and Escape land)
 * Captions never run without audio, unless the user skipped.
 */

export interface IntroLine {
  /** What's shown under the orb. */
  caption: string;
  /** What's said (the key named out loud). */
  spoken: string;
}

export const INTRO_LINES: readonly IntroLine[] = [
  { caption: "Hey. I'm Glance.", spoken: "Hey. I'm Glance." },
  { caption: "I live in your browser, on every page you read.", spoken: "I live in your browser, on every page you read." },
  { caption: "See a company in the news? Hold ⌥V and ask me about it.", spoken: "See a company in the news? Hold Option V and ask me about it." },
  { caption: "Looking at a chart? I'll explain it, and draw right on it.", spoken: "Looking at a chart? I'll explain it, and draw right on it." },
  {
    caption: "Want in? Say “buy ten dollars of Tesla”, and I'll buy it on Robinhood Chain.",
    spoken: "Want in? Say, buy ten dollars of Tesla, and I'll buy it on Robinhood Chain.",
  },
  { caption: "I trade from a vault you own, inside limits you set. I can never withdraw a cent.", spoken: "I trade from a vault you own, inside limits you set. I can never withdraw a cent." },
  { caption: "When the market's closed, I slow down on my own.", spoken: "When the market's closed, I slow down on my own." },
  { caption: "Pause me any time. Revoke me any time.", spoken: "Pause me any time. Revoke me any time." },
  { caption: "Ready when you are.", spoken: "Ready when you are." },
];

/** The silence between two lines. */
export const LINE_GAP_MS = 350;

/** Where line `i` (0-based) is kept, inside the extension. */
export const introFile = (i: number) => `/intro/line-${String(i + 1).padStart(2, "0")}.mp3`;

/** What scripts/gen-intro-audio.ts writes beside the audio: each line's text and length. */
export interface IntroManifest {
  voice: string;
  lines: Array<{ file: string; caption: string; spoken: string; durationMs: number; bytes: number }>;
}

export type IntroState = { phase: "ready" } | { phase: "blocked" } | { phase: "playing"; line: number } | { phase: "end" };

export type IntroEvent =
  /** Play from the first line (on load, the tap, or "Replay intro"). */
  | { type: "start" }
  /** The browser refused to play sound without a click. */
  | { type: "blocked" }
  /** The current line finished (its pause included). */
  | { type: "lineEnded" }
  /** "Skip intro", or Escape. */
  | { type: "skip" };

export function introStep(state: IntroState, event: IntroEvent, lines = INTRO_LINES.length): IntroState {
  switch (event.type) {
    case "start":
      return { phase: "playing", line: 0 };
    case "blocked":
      return state.phase === "end" ? state : { phase: "blocked" };
    case "skip":
      return { phase: "end" };
    case "lineEnded":
      if (state.phase !== "playing") return state;
      return state.line + 1 < lines ? { phase: "playing", line: state.line + 1 } : { phase: "end" };
  }
}

/** The caption on screen: only while its line is being said. */
export function captionFor(state: IntroState): string | null {
  return state.phase === "playing" ? (INTRO_LINES[state.line]?.caption ?? null) : null;
}

/**
 * Where the Welcome page starts: the intro plays on install, from Settings ("Show welcome again"), and before setup;
 * once Glance is set up, a later visit starts at the end state without playing.
 */
export function introStart(p: { installed: boolean; askedForIntro: boolean; setupComplete: boolean }): "play" | "end" {
  return p.installed || p.askedForIntro || !p.setupComplete ? "play" : "end";
}

/** Total length of the intro, from the manifest: every line, and the pauses between them. */
export function introDurationMs(m: Pick<IntroManifest, "lines">): number {
  return m.lines.reduce((s, l) => s + l.durationMs, 0) + LINE_GAP_MS * Math.max(0, m.lines.length - 1);
}
