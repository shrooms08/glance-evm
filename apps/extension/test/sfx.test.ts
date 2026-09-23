/**
 * The open and close sounds: decoded once, played from the buffers at the token volume, never stacked, silent when
 * switched off or when anything about audio fails, and only for the user's own open and close.
 */
import { describe, expect, it, vi } from "vitest";

import { Sfx, SoundCue } from "../lib/sfx";
import { sound } from "../lib/tokens";

function fakeAudio(state: AudioContextState = "running") {
  const sources: Array<{ buffer: unknown; started: boolean; stopped: boolean; gain: number | null }> = [];
  const ctx = {
    state,
    resume: vi.fn(async () => {
      ctx.state = "running";
    }),
    decodeAudioData: vi.fn(async (bytes: ArrayBuffer) => ({ bytes }) as unknown as AudioBuffer),
    destination: {} as AudioDestinationNode,
    createGain() {
      const g = { gain: { value: 1 }, connect: (d: unknown) => d };
      return g as unknown as GainNode;
    },
    createBufferSource() {
      const rec = { buffer: null as unknown, started: false, stopped: false, gain: null as number | null };
      sources.push(rec);
      const node = {
        set buffer(b: unknown) {
          rec.buffer = b;
        },
        onended: null,
        connect(g: GainNode) {
          rec.gain = g.gain.value; // read at play time, after the volume is set
          return { connect: () => undefined, get gain() { return g.gain; } };
        },
        start() {
          rec.started = true;
        },
        stop() {
          rec.stopped = true;
        },
      };
      return node as unknown as AudioBufferSourceNode;
    },
  };
  return { ctx, sources };
}

function listeners() {
  const map = new Map<string, EventListener>();
  return {
    target: {
      addEventListener: (t: string, l: EventListener) => map.set(t, l),
      removeEventListener: (t: string) => map.delete(t),
    } as unknown as Window,
    fire: (t: string) => map.get(t)?.(new Event(t)),
    has: (t: string) => map.has(t),
  };
}

const files: Record<string, ArrayBuffer> = { [sound.files.open]: new ArrayBuffer(1), [sound.files.close]: new ArrayBuffer(2) };

async function ready(state: AudioContextState = "running") {
  const audio = fakeAudio(state);
  const load = vi.fn(async (p: string) => files[p]!);
  const l = listeners();
  const sfx = new Sfx({ createContext: () => audio.ctx as unknown as AudioContext, load, target: l.target });
  await sfx.init();
  return { sfx, load, l, ...audio };
}

describe("Sfx", () => {
  it("decodes both files once at start, and plays from the decoded buffers", async () => {
    const { sfx, load, ctx, sources } = await ready();
    expect(load.mock.calls.map((c) => c[0]).sort()).toEqual([sound.files.close, sound.files.open].sort());
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(2);
    sfx.play("open");
    sfx.play("close");
    sfx.play("open");
    expect(load).toHaveBeenCalledTimes(2);
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(2);
    expect(sources.every((s) => s.started)).toBe(true);
    expect((sources[0]!.buffer as { bytes: ArrayBuffer }).bytes).toBe(files[sound.files.open]);
    expect((sources[1]!.buffer as { bytes: ArrayBuffer }).bytes).toBe(files[sound.files.close]);
  });

  it("plays at the token volume", async () => {
    const { sfx, sources } = await ready();
    sfx.play("open");
    expect(sources[0]!.gain).toBe(sound.volume);
    expect(sound.volume).toBeCloseTo(0.4);
  });

  it("stops a sound still playing before starting the next: rapid open and close never stack", async () => {
    const { sfx, sources } = await ready();
    sfx.play("open");
    sfx.play("close");
    sfx.play("open");
    expect(sources.map((s) => s.stopped)).toEqual([true, true, false]);
  });

  it("is silent when switched off, and stops what is playing", async () => {
    const { sfx, sources } = await ready();
    sfx.play("open");
    sfx.setEnabled(false);
    expect(sources[0]!.stopped).toBe(true);
    sfx.play("close");
    expect(sources).toHaveLength(1);
    sfx.setEnabled(true);
    sfx.play("close");
    expect(sources).toHaveLength(2);
  });

  it("resumes a suspended context on the first key press, then stops listening", async () => {
    const { l, ctx } = await ready("suspended");
    expect(l.has("keydown")).toBe(true);
    expect(l.has("pointerdown")).toBe(true);
    l.fire("keydown");
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe("running");
    expect(l.has("keydown")).toBe(false);
  });

  it("resumes a suspended context when asked to play rather than failing", async () => {
    const { sfx, ctx, sources } = await ready("suspended");
    sfx.play("open");
    expect(ctx.resume).toHaveBeenCalled();
    expect(sources[0]!.started).toBe(true);
  });

  it("fails silently: no AudioContext, a file that won't load or decode, a node that throws", async () => {
    const none = new Sfx({
      createContext: () => {
        throw new Error("no audio");
      },
      load: async () => new ArrayBuffer(0),
    });
    await expect(none.init()).resolves.toBeUndefined();
    expect(() => none.play("open")).not.toThrow();

    const audio = fakeAudio();
    const broken = new Sfx({
      createContext: () => audio.ctx as unknown as AudioContext,
      load: async (p) => {
        if (p === sound.files.open) throw new Error("404");
        return new ArrayBuffer(1);
      },
    });
    await broken.init();
    broken.play("open"); // this one didn't load: nothing
    expect(audio.sources).toHaveLength(0);
    broken.play("close"); // the other still works
    expect(audio.sources).toHaveLength(1);

    audio.ctx.createBufferSource = () => {
      throw new Error("boom");
    };
    expect(() => broken.play("close")).not.toThrow();
    expect(() => broken.dispose()).not.toThrow();
  });
});

describe("SoundCue", () => {
  it("only sounds for the direction the user just asked for, once", () => {
    let now = 0;
    const cue = new SoundCue(() => now);
    expect(cue.take("open")).toBe(false); // nobody asked: a voice or card open stays silent
    cue.request("open");
    expect(cue.take("open")).toBe(true);
    expect(cue.take("open")).toBe(false); // consumed
    cue.request("close");
    expect(cue.take("open")).toBe(false); // wrong direction
    cue.request("open");
    now = 10_000;
    expect(cue.take("open")).toBe(false); // stale
  });
});
