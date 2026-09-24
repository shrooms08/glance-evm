/**
 * Pre-recorded common lines. The lines with no values in them (@glance/core/persona FIXED_LINES: the greeting, the
 * advice decline, "Got it. Nothing bought, nothing sold.", errors and empty states) are generated once in the
 * configured voice and kept in the gitignored .cache (voice/<sha256 of voice + text>.mp3), so they play at once and in
 * the same voice every time. The key includes the voice: when DEEPGRAM_TTS_VOICE changes, every line is generated again
 * (in the background at startup, or on first use). Only audio the configured voice itself spoke is kept: a line that
 * fell through to another voice is played but never stored.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DetailedSpeaker {
  speakDetailed(text: string): Promise<{ audio: Uint8Array; mime: string; voice: string }>;
}

const norm = (text: string) => text.replace(/\s+/g, " ").trim();

export class PrerecordedLines {
  private readonly lines: Set<string>;
  private readonly memory = new Map<string, Uint8Array>();
  private readonly inflight = new Map<string, Promise<Uint8Array>>();

  constructor(
    /** The configured voice (the chain's first). */
    readonly voice: string,
    lines: readonly string[],
    /** Where the audio is kept; null keeps it in memory only (tests). */
    private readonly dir: string | null,
  ) {
    this.lines = new Set(lines.map(norm));
  }

  has(text: string): boolean {
    return this.lines.has(norm(text));
  }

  get size(): number {
    return this.lines.size;
  }

  private key(text: string): string {
    return createHash("sha256").update(`${this.voice}\n${norm(text)}`).digest("hex");
  }

  private file(key: string): string | null {
    return this.dir ? join(this.dir, `${key}.mp3`) : null;
  }

  /** The stored audio, or null. */
  get(text: string): Uint8Array | null {
    const key = this.key(text);
    const hit = this.memory.get(key);
    if (hit) return hit;
    const f = this.file(key);
    if (!f) return null;
    try {
      const audio = new Uint8Array(readFileSync(f));
      this.memory.set(key, audio);
      return audio;
    } catch {
      return null;
    }
  }

  /** The line's audio: stored, or generated now (and stored only if the configured voice spoke it). */
  async audio(text: string, chain: DetailedSpeaker): Promise<{ audio: Uint8Array; prerecorded: boolean; voice: string }> {
    const stored = this.get(text);
    if (stored) return { audio: stored, prerecorded: true, voice: this.voice };
    const key = this.key(text);
    const running = this.inflight.get(key);
    if (running) return { audio: await running, prerecorded: false, voice: this.voice };
    let spokenBy = this.voice;
    const p = chain.speakDetailed(norm(text)).then((out) => {
      spokenBy = out.voice;
      if (out.voice === this.voice) this.store(key, out.audio);
      return out.audio;
    });
    this.inflight.set(key, p);
    try {
      return { audio: await p, prerecorded: false, voice: spokenBy };
    } finally {
      this.inflight.delete(key);
    }
  }

  private store(key: string, audio: Uint8Array) {
    this.memory.set(key, audio);
    const f = this.file(key);
    if (!f) return;
    try {
      mkdirSync(dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, audio);
      renameSync(tmp, f);
    } catch {
      // best effort: memory still has it
    }
  }

  /** Generates every missing line, one at a time (at startup, in the background). Returns how many were generated. */
  async warm(chain: DetailedSpeaker, log: (line: string) => void = () => {}): Promise<number> {
    let made = 0;
    for (const line of this.lines) {
      if (this.get(line)) continue;
      try {
        const out = await this.audio(line, chain);
        if (!out.prerecorded) made++;
      } catch {
        // the voice isn't answering now: the line is generated on first use instead
      }
    }
    if (made) log(`[voice] pre-recorded ${made} of ${this.lines.size} common lines in ${this.voice}`);
    return made;
  }
}
