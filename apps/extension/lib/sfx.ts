/**
 * The open and close sounds. Decoded once with the Web Audio API when the content script starts, so the first use has
 * no load delay; played from the decoded buffers, at `sound.volume`. A new sound stops any still playing, so rapid
 * open-close never stacks. A page's AudioContext starts suspended until the user acts on the page: it is resumed on
 * the first key press or click. Any audio failure is silent: sound is decoration, never a reason for an error.
 */
import { sound } from "./tokens";

export type SfxName = "open" | "close";

type Ctx = Pick<AudioContext, "state" | "resume" | "decodeAudioData" | "createBufferSource" | "createGain" | "destination">;

export class Sfx {
  private ctx: Ctx | null = null;
  private buffers: Partial<Record<SfxName, AudioBuffer>> = {};
  private playing: AudioBufferSourceNode | null = null;
  private enabled: boolean = sound.enabledByDefault;
  private unlock: (() => void) | null = null;

  constructor(
    private readonly deps: {
      createContext(): Ctx;
      /** The bytes of a packaged file (e.g. fetch(chrome.runtime.getURL(path))). */
      load(path: string): Promise<ArrayBuffer>;
      /** Where to listen for the first key press or click that can resume audio. */
      target?: Pick<Window, "addEventListener" | "removeEventListener">;
    },
  ) {}

  /** Decodes both sounds. Never throws. */
  async init(): Promise<void> {
    try {
      this.ctx = this.deps.createContext();
      const decode = async (name: SfxName) => {
        try {
          this.buffers[name] = await this.ctx!.decodeAudioData(await this.deps.load(sound.files[name]));
        } catch {
          // this sound stays silent
        }
      };
      await Promise.all([decode("open"), decode("close")]);
      this.listenForUnlock();
    } catch {
      this.ctx = null;
    }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.stop();
  }

  /** Plays one sound now, stopping any still playing. Never throws. */
  play(name: SfxName) {
    try {
      if (!this.enabled || !this.ctx) return;
      const buffer = this.buffers[name];
      if (!buffer) return;
      this.stop();
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
      const source = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      gain.gain.value = sound.volume;
      source.buffer = buffer;
      source.connect(gain).connect(this.ctx.destination);
      source.onended = () => {
        if (this.playing === source) this.playing = null;
      };
      source.start(0);
      this.playing = source;
    } catch {
      // silent
    }
  }

  stop() {
    try {
      this.playing?.stop();
    } catch {
      // already stopped
    }
    this.playing = null;
  }

  /** A page's AudioContext stays suspended until the user acts: resume it on the first key press or click. */
  private listenForUnlock() {
    const target = this.deps.target;
    if (!target || !this.ctx || this.ctx.state !== "suspended") return;
    const unlock = () => {
      if (!this.ctx || this.ctx.state !== "suspended") return this.dropUnlock();
      void this.ctx.resume().then(
        () => this.dropUnlock(),
        () => {},
      );
    };
    this.unlock = unlock;
    target.addEventListener("keydown", unlock, true);
    target.addEventListener("pointerdown", unlock, true);
  }

  private dropUnlock() {
    if (!this.unlock || !this.deps.target) return;
    this.deps.target.removeEventListener("keydown", this.unlock, true);
    this.deps.target.removeEventListener("pointerdown", this.unlock, true);
    this.unlock = null;
  }

  /** Stops listening and releases nothing else (the page may keep its AudioContext). */
  dispose() {
    this.stop();
    this.dropUnlock();
  }
}

/**
 * Only a user's own open or close plays a sound: Option+G, the orb opening the panel, Escape, or the close button.
 * The request is remembered briefly and used when the liquid actually starts moving in that direction; a panel that
 * opens or closes for any other reason (voice, docking) finds no request and stays silent.
 */
export class SoundCue {
  private wanted: { dir: SfxName; at: number } | null = null;
  constructor(private readonly now: () => number = () => performance.now()) {}

  /** The user asked to open or close. */
  request(dir: SfxName) {
    this.wanted = { dir, at: this.now() };
  }

  /** The liquid started moving in `dir`: true (and consumed) if the user asked for exactly that, just now. */
  take(dir: SfxName, withinMs = 3_000): boolean {
    const w = this.wanted;
    this.wanted = null;
    return Boolean(w && w.dir === dir && this.now() - w.at <= withinMs);
  }
}
