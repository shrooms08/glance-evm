/**
 * The offscreen voice worker, with every browser dependency faked: MediaRecorder, the WebSocket to the Glance API,
 * the API's endpoints, the audio element that plays the reply, and the browser's own speech APIs (fallback only).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ListenHandlers } from "../lib/voice";
import type { SpeechEvent, VoiceEvent } from "../lib/voiceMessages";
import { toPcm16, VoiceWorker, wav, type WorkerDeps } from "../lib/voiceWorker";

const API = "http://localhost:8790";
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await tick();
};

class FakeWS {
  static last: FakeWS;
  sent: unknown[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  private closers: Array<() => void> = [];
  constructor(public url: string) {
    FakeWS.last = this;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  fail() {
    this.onerror?.();
    this.onclose?.();
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  reply(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  addEventListener(_: "close", f: () => void) {
    this.closers.push(f);
  }
  close() {
    this.readyState = 3;
    this.closers.forEach((f) => f());
  }
}

/** The PCM capture: the test "records" slices and decides when capture has flushed. */
class FakeCapture {
  static last: FakeCapture;
  onChunk!: (pcm: Uint8Array) => void;
  stopped = false;
  constructor() {
    FakeCapture.last = this;
  }
  chunk(n: number) {
    this.onChunk(new Uint8Array([n, n]));
  }
  async stop() {
    this.stopped = true;
    this.chunk(99); // the last slice comes out on stop
  }
}

class FakeAudio {
  static all: FakeAudio[] = [];
  src = "";
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  constructor() {
    FakeAudio.all.push(this);
  }
  play() {
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.onpause?.();
  }
}

interface Setup {
  status?: { transcription: boolean; speech: boolean; stream: boolean } | "unreachable";
  command?: object | "fail";
  transcribe?: object | "fail";
  blocker?: string | null;
  listen?: (h: ListenHandlers) => void;
}

function setup(o: Setup = {}) {
  const events: Array<VoiceEvent | SpeechEvent> = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let clock = 1_000;
  const status = o.status ?? { transcription: true, speech: true, stream: true };
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    requests.push({ url: u, init });
    if (u.endsWith("/voice/warm")) return Response.json({ ok: true });
    if (u.endsWith("/voice/status")) {
      if (status === "unreachable") throw new TypeError("Failed to fetch");
      return Response.json({ available: status });
    }
    if (u.endsWith("/voice/command")) {
      if (o.command === "fail") throw new TypeError("Failed to fetch");
      return Response.json(o.command ?? { intent: "price", symbol: "TSLA", amount: null, reply: "Tesla is at $380." });
    }
    if (u.endsWith("/voice/transcribe")) {
      if (o.transcribe === "fail") throw new TypeError("Failed to fetch");
      return Response.json(o.transcribe ?? { text: "what's Tesla at", confidence: 0.9 });
    }
    throw new Error(`unexpected ${u}`);
  });
  const speakLocally = vi.fn(async (_t: string, onStart: () => void) => {
    onStart();
    return true;
  });
  const listen = vi.fn((_lang: string, h: ListenHandlers) => {
    o.listen?.(h);
    return { stop: vi.fn(), abort: vi.fn() };
  });
  const deps: WorkerDeps = {
    fetch: fetchFn as unknown as typeof fetch,
    WebSocket: FakeWS as never,
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) as unknown as MediaStream,
    capturePcm: async (_stream, onChunk) => {
      const c = new FakeCapture();
      c.onChunk = onChunk;
      return c;
    },
    createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
    micBlocker: async () => (o.blocker ?? null) as never,
    listen: listen as never,
    speakLocally,
    emit: (e) => events.push(e),
    now: () => clock,
  };
  const worker = new VoiceWorker(deps);
  const types = () => events.filter((e): e is VoiceEvent => e.kind === "voice:event").map((e) => e.type);
  return { worker, events, requests, types, listen, speakLocally, advance: (ms: number) => (clock += ms) };
}

beforeEach(() => {
  FakeAudio.all = [];
});

describe("voice worker: the server path", () => {
  it("streams audio while held, and on release: transcript, intent, and the reply playing in Glance's voice", async () => {
    const t = setup();
    void t.worker.start("s1", "en-US", API, { host: "cnbc.com" }, "0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D");
    await flush();
    expect(FakeWS.last.url).toBe("ws://localhost:8790/voice/stream?vault=0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D");
    expect(t.types()).toEqual(["started"]);

    // Chunks recorded before the socket opens are sent, in order, once it does; later ones go straight out.
    FakeCapture.last.chunk(1);
    FakeWS.last.open();
    FakeCapture.last.chunk(2);
    await flush();
    expect(FakeWS.last.sent.map((c) => [...(c as Uint8Array)])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    // Key down also asked the API to warm its provider connections.
    expect(t.requests[0]!.url).toBe(`${API}/voice/warm`);

    const stopping = t.worker.stop("s1");
    await flush();
    expect(t.types()).toContain("released");
    expect(FakeWS.last.sent.at(-1)).toBe(JSON.stringify({ type: "stop" }));
    t.advance(350);
    FakeWS.last.reply({ type: "transcript", text: "what's Tesla at", confidence: 0.95 });
    await stopping;
    await flush();

    const command = t.requests.find((r) => r.url.endsWith("/voice/command"))!;
    expect(JSON.parse(String(command.init!.body))).toEqual({
      transcript: "what's Tesla at",
      context: { host: "cnbc.com" },
      vault: "0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D",
    });
    expect(t.types()).toEqual(["started", "released", "final", "intent"]);

    // The reply plays from the API; the speaking state follows the audio element's own events.
    const audio = FakeAudio.all.at(-1)!;
    expect(audio.src).toBe(`${API}/voice/speak?text=${encodeURIComponent("Tesla is at $380.")}`);
    t.advance(500);
    audio.onplaying!();
    await flush();
    expect(t.events.filter((e) => e.kind === "voice:speech")).toEqual([{ kind: "voice:speech", id: "s1", type: "start" }]);
    const timing = t.events.find((e) => e.kind === "voice:event" && e.type === "timing") as Extract<VoiceEvent, { type: "timing" }>;
    expect(timing.timing).toEqual({ transcript: 350, intent: 350, speaking: 850, via: "stream" });
    expect(t.types().at(-1)).toBe("end");
    audio.onended!();
    await flush();
    expect(t.events.at(-1)).toEqual({ kind: "voice:speech", id: "s1", type: "end" });
  });

  it("a key released before recording started stops as soon as it does", async () => {
    const t = setup();
    void t.worker.start("s2", "en-US", API, {});
    void t.worker.stop("s2"); // released while the mic was still being checked
    await flush();
    FakeWS.last.open();
    await flush();
    expect(FakeCapture.last.stopped).toBe(true);
    expect(t.types()).toContain("released");
  });

  it("uploads the whole recording if the stream can't open", async () => {
    const t = setup();
    void t.worker.start("s3", "en-US", API, {});
    await flush();
    FakeWS.last.fail();
    FakeCapture.last.chunk(1);
    await t.worker.stop("s3");
    await flush();
    const upload = t.requests.find((r) => r.url.endsWith("/voice/transcribe"))!;
    expect((upload.init!.headers as Record<string, string>)["content-type"]).toBe("audio/wav");
    const body = new Uint8Array(await (upload.init!.body as Blob).arrayBuffer());
    expect(new TextDecoder().decode(body.subarray(0, 4))).toBe("RIFF");
    expect(body.byteLength).toBe(44 + 4); // header + the two 2-byte slices
    expect(t.types()).toContain("final");
    expect((t.events.find((e) => e.kind === "voice:event" && e.type === "final") as { text: string }).text).toBe("what's Tesla at");
  });

  it("if the API can't understand it, the words still reach the page (which parses them itself)", async () => {
    const t = setup({ command: "fail" });
    void t.worker.start("s4", "en-US", API, {});
    await flush();
    FakeWS.last.open();
    const stopping = t.worker.stop("s4");
    await flush();
    FakeWS.last.reply({ type: "transcript", text: "buy ten dollars of Tesla" });
    await stopping;
    await flush();
    expect(t.types()).toEqual(["started", "released", "final", "timing", "end"]);
  });

  it("says why when transcription fails outright", async () => {
    const t = setup({ transcribe: "fail" });
    void t.worker.start("s5", "en-US", API, {});
    await flush();
    FakeWS.last.fail();
    await t.worker.stop("s5");
    await flush();
    expect(t.events).toContainEqual(expect.objectContaining({ type: "error", code: "transcription-failed" }));
    expect(t.types().at(-1)).toBe("end");
  });

  it("never records without the microphone permission, and says so", async () => {
    const t = setup({ blocker: "mic-not-enabled" });
    await t.worker.start("s6", "en-US", API, {});
    expect(t.events).toContainEqual(expect.objectContaining({ type: "error", code: "mic-not-enabled" }));
    expect(t.types().at(-1)).toBe("end");
  });
});

describe("voice worker: fallback to the browser, said plainly", () => {
  it("uses the browser's speech recognition only when the API can't be reached", async () => {
    const t = setup({ status: "unreachable", listen: (h) => h.onStart?.() });
    await t.worker.start("f1", "en-US", API, {});
    expect(t.events[0]).toMatchObject({ type: "fallback", reason: "api-unreachable" });
    expect(t.listen).toHaveBeenCalled();
    expect(t.types()).toEqual(["fallback", "started"]);
  });

  it("or when it has no transcription provider", async () => {
    const t = setup({ status: { transcription: false, speech: false, stream: false } });
    await t.worker.start("f2", "en-US", API, {});
    expect(t.events[0]).toMatchObject({ type: "fallback", reason: "no-provider" });
  });

  it("in Brave (no browser recognition either), the reason still arrives", async () => {
    const t = setup({ status: "unreachable", listen: (h) => (h.onError("no-recognition"), h.onEnd?.()) });
    await t.worker.start("f3", "en-US", API, {});
    expect(t.types()).toEqual(["fallback", "error", "end"]);
  });
});

describe("voice worker: spoken replies", () => {
  it("queue behind each other, and a new key press silences them", async () => {
    const t = setup();
    const first = t.worker.speak("r1", "$10 of Tesla. Checking your vault's limits.", API);
    const second = t.worker.speak("r2", "$10 of Tesla at $380. Confirm?", API);
    await flush();
    expect(FakeAudio.all).toHaveLength(1); // the second waits
    FakeAudio.all[0]!.onplaying!();
    FakeAudio.all[0]!.onended!();
    await first;
    await flush();
    expect(FakeAudio.all).toHaveLength(2);
    t.worker.hush();
    await second;
    expect(FakeAudio.all[1]!.paused).toBe(true);
  });

  it("fall back to the browser's voice when the API has no speech provider", async () => {
    const t = setup({ status: { transcription: true, speech: false, stream: true } });
    await t.worker.speak("r3", "Tesla is at $380.", API);
    expect(t.speakLocally).toHaveBeenCalledWith("Tesla is at $380.", expect.any(Function));
    expect(t.events.filter((e) => e.kind === "voice:speech").map((e) => (e as SpeechEvent).type)).toEqual(["start", "end"]);
  });
});

describe("PCM helpers", () => {
  it("converts float samples to 16-bit little-endian PCM, clipped", () => {
    const pcm = new DataView(toPcm16(new Float32Array([0, 1, -1, 2])).buffer);
    expect([pcm.getInt16(0, true), pcm.getInt16(2, true), pcm.getInt16(4, true), pcm.getInt16(6, true)]).toEqual([0, 32767, -32768, 32767]);
  });
  it("wraps PCM in a 16kHz mono WAV header", async () => {
    const bytes = new DataView(await wav([new Uint8Array(8)]).arrayBuffer());
    expect(bytes.getUint32(24, true)).toBe(16_000);
    expect(bytes.getUint16(22, true)).toBe(1);
    expect(bytes.getUint32(40, true)).toBe(8);
  });
});
