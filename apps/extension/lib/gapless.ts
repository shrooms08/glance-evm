/**
 * Gapless playback for a reply in sentences: one audio context per answer, each sentence decoded whole and started at
 * the exact time the one before it ends (source.start(at)), never on an 'ended' event, with short fades at the edges
 * so the joins don't click. The audio thread plays what is scheduled, so a busy page or document can't open a gap.
 *
 * Pure scheduling here (Timeline) plus the thin Web Audio output (webAudioOut) the offscreen document uses; the
 * worker (lib/voiceWorker.ts) feeds it and reports where it got to.
 */

/** Sound queued ahead before the first sentence starts (the start buffer). */
export const START_BUFFER_S = 0.2;
/** Fade in and out at each sentence's edges. */
export const FADE_S = 0.004;
/** A slice scheduled less than this ahead of now is late: it starts this far ahead instead. */
export const GUARD_S = 0.02;
/** Sentences fetched ahead of the one playing (N+1 and N+2). */
export const PREFETCH = 2;
/**
 * While a sentence is still arriving, its last this-many seconds of decoded sound are held back: the decoder may trim
 * or finish them differently once more bytes come.
 */
export const TAIL_HOLD_S = 0.15;
/** The smallest slice worth scheduling while a sentence is still arriving. */
export const MIN_SLICE_S = 0.1;

export interface Decoded {
  /** Seconds. */
  duration: number;
  sampleRate: number;
  /** Samples. */
  length: number;
}

/** Where the sound goes: an AudioContext in the offscreen document, a fake in tests. */
export interface AudioOut<B extends Decoded = Decoded> {
  /** The output clock, in seconds. */
  readonly currentTime: number;
  readonly sampleRate: number;
  decode(bytes: ArrayBuffer): Promise<B>;
  /** Samples `from` to `to` of `buffer`, as a buffer of their own. */
  slice(buffer: B, from: number, to: number): B;
  /** Plays `buffer` from `at` (output seconds), fading in and out over the given seconds (0: no fade). */
  play(buffer: B, at: number, fade: { in: number; out: number }): { stop(): void };
  close(): void;
}

export interface Placed {
  start: number;
  end: number;
  /** Silence before this sentence (seconds): 0 when it follows the last one exactly. */
  gap: number;
  /** It was ready after the last one ended (the audio ran dry). */
  late: boolean;
}

/** Back-to-back start times: each sentence starts where the last one ends, or as soon as it can when it came late. */
export class Timeline {
  private next: number | null = null;

  constructor(
    private readonly lead = START_BUFFER_S,
    private readonly guard = GUARD_S,
  ) {}

  /** When the queued sound runs out (null before anything was placed). */
  get end(): number | null {
    return this.next;
  }

  place(now: number, duration: number): Placed {
    let start: number;
    let gap = 0;
    let late = false;
    if (this.next === null) start = now + this.lead;
    else if (this.next >= now + this.guard) start = this.next;
    else {
      start = now + this.guard;
      gap = start - this.next;
      late = true;
    }
    this.next = start + duration;
    return { start, end: this.next, gap, late };
  }
}

/**
 * The Web Audio output, at `sampleRate` when given (the speech's own rate, so nothing is resampled on decode) and
 * with the playback latency hint (a larger, steadier buffer).
 */
export function webAudioOut(sampleRate: number | null): AudioOut<AudioBuffer> {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ latencyHint: "playback", ...(sampleRate ? { sampleRate } : {}) });
  } catch {
    ctx = new AudioContext({ latencyHint: "playback" }); // a rate this browser won't open: decode resamples
  }
  void ctx.resume().catch(() => {});
  return {
    get currentTime() {
      return ctx.currentTime;
    },
    sampleRate: ctx.sampleRate,
    decode: (bytes) => ctx.decodeAudioData(bytes),
    slice(buffer, from, to) {
      const out = ctx.createBuffer(buffer.numberOfChannels, Math.max(1, to - from), buffer.sampleRate);
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) out.copyToChannel(buffer.getChannelData(ch).subarray(from, to), ch);
      return out;
    },
    play(buffer, at, fade) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      const end = at + buffer.duration;
      const fin = Math.min(fade.in, buffer.duration / 4);
      const fout = Math.min(fade.out, buffer.duration / 4);
      if (fin > 0) {
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(1, at + fin);
      } else gain.gain.setValueAtTime(1, at);
      if (fout > 0) {
        gain.gain.setValueAtTime(1, end - fout);
        gain.gain.linearRampToValueAtTime(0, end);
      }
      src.connect(gain).connect(ctx.destination);
      src.start(at);
      return {
        stop() {
          try {
            src.stop();
            src.disconnect();
          } catch {
            // never started, or already stopped
          }
        },
      };
    },
    close() {
      void ctx.close().catch(() => {});
    },
  };
}

const MPEG1_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/**
 * Where the last whole MP3 frame (layer III) in `bytes` ends, so a sentence still arriving is decoded up to a frame
 * boundary. Null when `bytes` doesn't start as MP3 (then it is decoded as it is).
 */
export function mp3FrameEnd(bytes: Uint8Array): number | null {
  let i = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    if (bytes.length < 10) return 0;
    i = 10 + (((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f));
  }
  let end: number | null = null;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff || (bytes[i + 1]! & 0xe0) !== 0xe0) return end;
    const version = (bytes[i + 1]! >> 3) & 0x03; // 3: MPEG 1, 2: MPEG 2, 0: MPEG 2.5
    const layer = (bytes[i + 1]! >> 1) & 0x03; // 1: layer III
    const kbps = (version === 3 ? MPEG1_KBPS : MPEG2_KBPS)[bytes[i + 2]! >> 4];
    const rateIndex = (bytes[i + 2]! >> 2) & 0x03;
    if (version === 1 || layer !== 1 || !kbps || rateIndex === 3) return end;
    const rate = [44_100, 48_000, 32_000][rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const padding = (bytes[i + 2]! >> 1) & 0x01;
    const length = Math.floor(((version === 3 ? 144_000 : 72_000) * kbps) / rate) + padding;
    if (i + length > bytes.length) return end ?? 0;
    i += length;
    end = i;
  }
  return end ?? 0;
}
