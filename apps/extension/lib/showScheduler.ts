/**
 * Fires Show me's actions in step with the voice. The whole reply is spoken as one TTS call; each action fires when
 * playback reaches its share of the text (fireTime, from @glance/core/showme), re-estimated as the player learns the
 * audio's length. Actions in the first sentence fire as soon as the voice starts. In order, each once. cancel() stops
 * everything (Escape), and nothing fires after it.
 */
import { fireTime, type ShowAction } from "@glance/core/showme";

export class ShowScheduler {
  private next = 0;
  private cancelled = false;
  private started = false;
  private readonly ordered: ShowAction[];

  constructor(
    actions: readonly ShowAction[],
    private readonly spoken: string,
    private readonly fire: (a: ShowAction) => void,
  ) {
    this.ordered = [...actions].sort((a, b) => a.at - b.at);
  }

  /** The voice started: fire everything due at time 0. */
  start() {
    this.started = true;
    this.progress(0, null);
  }

  /** Playback is at `t` seconds of `duration` (null while unknown). */
  progress(t: number, duration: number | null) {
    if (this.cancelled || !this.started) return;
    while (this.next < this.ordered.length) {
      const a = this.ordered[this.next]!;
      if (fireTime(a.at, this.spoken, duration) > t) break;
      this.next++;
      this.fire(a);
    }
  }

  /** The voice ended (or never played): anything left fires now, in order. */
  finish() {
    if (this.cancelled) return;
    this.started = true;
    this.progress(Number.POSITIVE_INFINITY, null);
  }

  cancel() {
    this.cancelled = true;
  }

  get done(): boolean {
    return this.cancelled || this.next >= this.ordered.length;
  }
}
