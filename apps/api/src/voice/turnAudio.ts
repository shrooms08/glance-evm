/**
 * One voice turn's audio as the API received it from the extension (16kHz 16-bit mono PCM): kept from the first byte,
 * so a turn the stream got nothing out of can go to the upload path once, and measured, so the per-turn log line says
 * whether there was speech in it at all (levels in dBFS; never the audio or the words).
 */

const SAMPLE_RATE = 16_000;
/** 40ms windows: the extension's slice. */
const WINDOW_SAMPLES = 640;
/** A window this loud (RMS) counts as speech. A quiet room through the browser's noise suppression sits near -60 dBFS. */
export const SPEECH_RMS_DBFS = -48;
/** This much speech-level audio makes a turn worth a second opinion when the provider heard nothing. */
export const MIN_SPEECH_MS = 160;

const dbfs = (x: number) => (x <= 0 ? -120 : Math.max(-120, 20 * Math.log10(x / 32_768)));

export class TurnAudio {
  private chunks: Uint8Array[] = [];
  bytes = 0;
  private peak = 0;
  private sumSquares = 0;
  private samples = 0;
  private speechWindows = 0;
  /** The window being filled across chunk boundaries. */
  private windowSquares = 0;
  private windowSamples = 0;
  /** An odd byte left over from the last chunk. */
  private carry: number | null = null;

  add(chunk: Uint8Array) {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    let i = 0;
    if (this.carry !== null && chunk.byteLength) {
      this.sample(((chunk[0]! << 8) | this.carry) << 16 >> 16);
      this.carry = null;
      i = 1;
    }
    for (; i + 1 < chunk.byteLength; i += 2) this.sample(((chunk[i + 1]! << 8) | chunk[i]!) << 16 >> 16);
    if (i < chunk.byteLength) this.carry = chunk[i]!;
  }

  private sample(v: number) {
    const a = Math.abs(v);
    if (a > this.peak) this.peak = a;
    this.sumSquares += v * v;
    this.samples++;
    this.windowSquares += v * v;
    if (++this.windowSamples === WINDOW_SAMPLES) {
      if (dbfs(Math.sqrt(this.windowSquares / WINDOW_SAMPLES)) >= SPEECH_RMS_DBFS) this.speechWindows++;
      this.windowSquares = 0;
      this.windowSamples = 0;
    }
  }

  get seconds() {
    return this.bytes / (2 * SAMPLE_RATE);
  }

  get levels() {
    return {
      peakDbfs: Math.round(dbfs(this.peak)),
      avgDbfs: Math.round(dbfs(this.samples ? Math.sqrt(this.sumSquares / this.samples) : 0)),
      speechMs: this.speechWindows * 40,
    };
  }

  /** Speech-level energy somewhere in the turn (not silence, not a click). */
  get hadSpeech() {
    return this.levels.speechMs >= MIN_SPEECH_MS;
  }

  /** The turn as a WAV file, for the upload path. */
  wav(): Uint8Array {
    const out = new Uint8Array(44 + this.bytes);
    const v = new DataView(out.buffer);
    const text = (at: number, s: string) => [...s].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)));
    text(0, "RIFF");
    v.setUint32(4, 36 + this.bytes, true);
    text(8, "WAVE");
    text(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, SAMPLE_RATE, true);
    v.setUint32(28, SAMPLE_RATE * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    text(36, "data");
    v.setUint32(40, this.bytes, true);
    let at = 44;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}
