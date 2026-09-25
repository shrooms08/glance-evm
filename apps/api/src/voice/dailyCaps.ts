/**
 * Daily caps on paid voice: Deepgram speech-to-text seconds and text-to-speech characters per UTC day (defaults 1,800s
 * and 60,000 characters; VOICE_STT_SECONDS_PER_DAY and VOICE_TTS_CHARS_PER_DAY override). When one is used up, that
 * direction rests until midnight UTC and Glance says so in text: "Voice is resting for today. You can still type."
 * Pre-recorded lines and phrases served from memory never reach a provider, so they never count.
 *
 * The counters survive a restart (a small JSON file next to the LLM usage), so restarting the API doesn't reset them.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { VOICE_RESTING } from "@glance/core/session";

/** Thrown by a capped speaker, and turned into 503 VOICE_RESTING by the routes. */
export class VoiceRestingError extends Error {
  readonly code = "VOICE_RESTING";
  constructor() {
    super(VOICE_RESTING);
  }
}

const today = (now: number) => new Date(now).toISOString().slice(0, 10);

export class DailyMeter {
  private day: string;
  private used = 0;

  constructor(
    readonly limit: number,
    private readonly store: { load(): number; save(used: number): void } | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.day = today(this.now());
    this.used = store?.load() ?? 0;
  }

  private roll() {
    const d = today(this.now());
    if (d !== this.day) {
      this.day = d;
      this.used = 0;
      this.store?.save(0);
    }
  }

  /** Nothing left today. */
  get resting(): boolean {
    this.roll();
    return this.used >= this.limit;
  }

  get usedToday(): number {
    this.roll();
    return this.used;
  }

  add(amount: number) {
    this.roll();
    this.used += Math.max(0, amount);
    this.store?.save(this.used);
  }
}

/**
 * The meters in one file: { day, sttSeconds, ttsChars, aaiSeconds }. `assemblyai` counts AssemblyAI streaming seconds
 * as it bills them (session wall-clock; ASSEMBLYAI_STT_SECONDS_PER_DAY): when it's used up, Deepgram listens instead,
 * and `stt` (every provider's audio seconds) still decides when voice rests.
 */
export function voiceMeters(o: { sttSecondsPerDay: number; ttsCharsPerDay: number; assemblyaiSecondsPerDay?: number; file: string | null; now?: () => number }) {
  const now = o.now ?? Date.now;
  let data: { day: string; sttSeconds: number; ttsChars: number; aaiSeconds?: number } = { day: today(now()), sttSeconds: 0, ttsChars: 0, aaiSeconds: 0 };
  if (o.file && existsSync(o.file)) {
    try {
      const read = JSON.parse(readFileSync(o.file, "utf8")) as typeof data;
      if (read.day === today(now())) data = read;
    } catch {
      // unreadable: start the day at zero
    }
  }
  const write = () => {
    if (!o.file) return;
    mkdirSync(dirname(o.file), { recursive: true });
    writeFileSync(`${o.file}.tmp`, JSON.stringify(data));
    renameSync(`${o.file}.tmp`, o.file);
  };
  const field = (k: "sttSeconds" | "ttsChars" | "aaiSeconds") => ({
    load: () => data[k] ?? 0,
    save: (used: number) => {
      if (data.day !== today(now())) data = { day: today(now()), sttSeconds: 0, ttsChars: 0, aaiSeconds: 0 };
      data[k] = used;
      write();
    },
  });
  return {
    stt: new DailyMeter(o.sttSecondsPerDay, field("sttSeconds"), now),
    tts: new DailyMeter(o.ttsCharsPerDay, field("ttsChars"), now),
    assemblyai: new DailyMeter(o.assemblyaiSecondsPerDay ?? 1_800, field("aaiSeconds"), now),
  };
}

export type VoiceMeters = ReturnType<typeof voiceMeters>;

/** One daily meter in its own small file ({ day, used }): e.g. chart-calibration vision calls. */
export function fileMeter(limit: number, file: string | null, now: () => number = Date.now): DailyMeter {
  const store = {
    load: () => {
      if (!file || !existsSync(file)) return 0;
      try {
        const d = JSON.parse(readFileSync(file, "utf8")) as { day?: string; used?: number };
        return d.day === today(now()) ? (d.used ?? 0) : 0;
      } catch {
        return 0;
      }
    },
    save: (used: number) => {
      if (!file) return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ day: today(now()), used }));
      renameSync(`${file}.tmp`, file);
    },
  };
  return new DailyMeter(limit, store, now);
}
