/**
 * One line per spoken answer, to see where the voice breaks: each chunk (a sentence) with the voice that said it, when
 * its request started, its first byte came, it was ready, and it started and ended playing; the gap between one
 * chunk's end and the next one's start (over BREAK_MS counts as a break); buffer underruns (the audio ran out while
 * more was expected); the audio's sample rate against the player's; and main-thread long tasks during playback, with
 * what was running. Pure: the player feeds it, it formats.
 */

/** A gap longer than this between two chunks is heard as a break. */
export const BREAK_MS = 80;

export interface ChunkTiming {
  index: number;
  /** "flux-sienna-en", "aura-2-harmonia-en", a retry of either, or "prerecorded". */
  model: string | null;
  /** When the sentence's text reached the player (it can't be asked for before). */
  textAt: number | null;
  requestAt: number | null;
  firstByteAt: number | null;
  readyAt: number | null;
  playStartAt: number | null;
  playEndAt: number | null;
  /** The audio's own sample rate, from its first MP3 frame (null when not known). */
  sampleRate: number | null;
}

export interface LongTask {
  at: number;
  ms: number;
  /** What was running then, when known: "canvas trace", "mark drawing", "vision", "DOM scan". */
  during: string | null;
  where: "page" | "player";
}

export class VoiceReport {
  readonly chunks: ChunkTiming[] = [];
  underruns = 0;
  /** Silences inside a sentence (ms): its next slice came after the last one had played. */
  innerGaps: number[] = [];
  voices = new Set<string>();
  longTasks: LongTask[] = [];
  outcome: "ended" | "cut" | "unavailable" | "on-screen" = "ended";

  constructor(
    readonly id: string,
    readonly player: "element" | "webaudio",
    public contextRate: number | null,
  ) {}

  chunk(index: number): ChunkTiming {
    let c = this.chunks[index];
    if (!c) {
      c = { index, model: null, textAt: null, requestAt: null, firstByteAt: null, readyAt: null, playStartAt: null, playEndAt: null, sampleRate: null };
      this.chunks[index] = c;
    }
    return c;
  }

  /** The gaps between consecutive chunks (ms; negative is an overlap, which a scheduler never makes). */
  gaps(): number[] {
    const out: number[] = [];
    for (let i = 1; i < this.chunks.length; i++) {
      const a = this.chunks[i - 1];
      const b = this.chunks[i];
      if (a?.playEndAt != null && b?.playStartAt != null) out.push(Math.round(b.playStartAt - a.playEndAt));
    }
    return out;
  }

  breaks(): number {
    return [...this.gaps(), ...this.innerGaps].filter((g) => g > BREAK_MS).length;
  }

  /** Voices that said part of this answer: more than one is a voice change mid-answer. */
  voiceChanges(): number {
    return Math.max(0, this.voices.size - 1);
  }

  summary() {
    const gaps = this.gaps();
    const t0 = this.chunks[0]?.textAt ?? this.chunks[0]?.requestAt ?? 0;
    const rel = (v: number | null) => (v === null ? null : Math.round(v - t0));
    return {
      id: this.id,
      player: this.player,
      outcome: this.outcome,
      sentences: this.chunks.length,
      chunks: this.chunks.map((c) => ({
        i: c.index,
        model: c.model,
        text: rel(c.textAt),
        req: rel(c.requestAt),
        firstByte: rel(c.firstByteAt),
        ready: rel(c.readyAt),
        start: rel(c.playStartAt),
        end: rel(c.playEndAt),
        rate: c.sampleRate,
      })),
      gaps,
      innerGaps: this.innerGaps,
      breaks: this.breaks(),
      maxGap: Math.max(0, ...gaps, ...this.innerGaps),
      underruns: this.underruns,
      voiceChanges: this.voiceChanges(),
      contextRate: this.contextRate,
      rates: [...new Set(this.chunks.map((c) => c.sampleRate).filter((r): r is number => r !== null))],
      longTasks: this.longTasks.map((t) => ({ ms: Math.round(t.ms), during: t.during, where: t.where })),
    };
  }

  line(): string {
    return `[glance] voice report ${JSON.stringify(this.summary())}`;
  }
}

/** The sample rate in the first MP3 frame header of `bytes` (MPEG 1, 2 or 2.5, layer III), or null. */
export function mp3SampleRate(bytes: Uint8Array): number | null {
  let i = 0;
  // Skip an ID3v2 tag.
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length > 10) {
    i = 10 + (((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f));
  }
  for (; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1]! & 0xe0) !== 0xe0) continue;
    const version = (bytes[i + 1]! >> 3) & 0x03; // 3: MPEG 1, 2: MPEG 2, 0: MPEG 2.5
    const index = (bytes[i + 2]! >> 2) & 0x03;
    if (version === 1 || index === 3) continue;
    const base = [44_100, 48_000, 32_000][index]!;
    return version === 3 ? base : version === 2 ? base / 2 : base / 4;
  }
  return null;
}
