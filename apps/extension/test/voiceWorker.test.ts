/**
 * The offscreen voice worker, with every browser dependency faked: MediaRecorder, the WebSocket to the Glance API,
 * the API's endpoints, the audio element that plays the reply, and the browser's own speech APIs (fallback only).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ListenHandlers } from "../lib/voice";
import { ACKS, FIXED_LINES, LINES } from "@glance/core/persona";
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
  currentTime = 0;
  duration = Number.NaN;
  onplaying: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
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
  /** What the background answers for a microphone failure. */
  blocker?: string | null;
  /** getUserMedia fails with this DOMException name. */
  mic?: string;
  /** The configured voice the API reports. */
  voice?: string;
  listen?: (h: ListenHandlers) => void;
  /** Answers /voice/speak itself (the default: a clip, always). */
  speak?: (url: string) => Response | undefined;
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
      return Response.json({ available: status, speechChain: [{ voice: o.voice ?? "flux-sienna-en" }] });
    }
    if (u.endsWith("/voice/command")) {
      if (o.command === "fail") throw new TypeError("Failed to fetch");
      return Response.json(o.command ?? { intent: "price", symbol: "TSLA", amount: null, reply: "Tesla is at $380." });
    }
    if (u.endsWith("/voice/transcribe")) {
      if (o.transcribe === "fail") throw new TypeError("Failed to fetch");
      return Response.json(o.transcribe ?? { text: "what's Tesla at", confidence: 0.9 });
    }
    const own = u.includes("/voice/speak?") ? o.speak?.(u) : undefined;
    if (own) return own;
    if (u.includes("/voice/speak?")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg", "x-voice": o.voice ?? "flux-sienna-en", "x-voice-cache": "prerecorded" } });
    throw new Error(`unexpected ${u}`);
  });
  // The browser's own voice: it must never be used for a reply.
  const speechSynthesis = { speak: vi.fn(), cancel: vi.fn(), getVoices: vi.fn(() => []) };
  vi.stubGlobal("speechSynthesis", speechSynthesis);
  const errorTone = vi.fn();
  const listen = vi.fn((_lang: string, h: ListenHandlers) => {
    o.listen?.(h);
    return { stop: vi.fn(), abort: vi.fn() };
  });
  const deps: WorkerDeps = {
    fetch: fetchFn as unknown as typeof fetch,
    WebSocket: FakeWS as never,
    getUserMedia: async () => {
      if (o.mic) throw new DOMException("mic", o.mic);
      return { getTracks: () => [{ stop() {} }] } as unknown as MediaStream;
    },
    capturePcm: async (_stream, onChunk) => {
      const c = new FakeCapture();
      c.onChunk = onChunk;
      return c;
    },
    createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
    micFailed: vi.fn(async () => (o.blocker ?? "mic-denied") as never),
    micWorked: vi.fn(),
    listen: listen as never,
    errorTone,
    objectUrl: vi.fn(() => "blob:clip"),
    emit: (e) => events.push(e),
    now: () => clock,
  };
  const worker = new VoiceWorker(deps);
  const types = () => events.filter((e): e is VoiceEvent => e.kind === "voice:event").map((e) => e.type);
  const speech = () => events.filter((e): e is SpeechEvent => e.kind === "voice:speech").map((e) => e.type);
  return { worker, deps, events, requests, types, listen, errorTone, speechSynthesis, speech, advance: (ms: number) => (clock += ms) };
}

beforeEach(() => {
  FakeAudio.all = [];
});

describe("voice worker: the server path", () => {
  it("streams audio while held, and on release: transcript, intent, and the reply playing in Glance's voice", async () => {
    const t = setup();
    void t.worker.start("s1", "en-US", API, { host: "cnbc.com" }, "0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D");
    await flush();
    expect(FakeWS.last.url).toBe(`ws://localhost:8790/voice/stream?vault=0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D&client=${t.worker.client}`);
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
    // Key down also asked the API to warm its provider connections, and to open this browser's AssemblyAI session.
    expect(t.requests[0]!.url).toBe(`${API}/voice/warm?for=key-down&client=${t.worker.client}`);

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

  it("tries the microphone straight away: when it opens, no Enable prompt, and it's remembered as working", async () => {
    const t = setup();
    void t.worker.start("s6", "en-US", API, {});
    await flush();
    expect(t.deps.micFailed).not.toHaveBeenCalled();
    expect(t.deps.micWorked).toHaveBeenCalledTimes(1);
    expect(t.events.some((e) => e.kind === "voice:event" && e.type === "error")).toBe(false);
  });

  it("only a real getUserMedia failure says anything, in the words the background chose", async () => {
    const t = setup({ mic: "NotAllowedError", blocker: "mic-not-enabled" });
    await t.worker.start("s7", "en-US", API, {});
    expect(t.deps.micFailed).toHaveBeenCalledWith("NotAllowedError");
    expect(t.events).toContainEqual(expect.objectContaining({ type: "error", code: "mic-not-enabled" }));
    expect(t.types().at(-1)).toBe("end");
    expect(t.deps.micWorked).not.toHaveBeenCalled();
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

  it("no voice (no speech provider, or the API down): the text stays shown, a soft tone, nothing said, never the browser's voice", async () => {
    for (const status of [{ transcription: true, speech: false, stream: true }, "unreachable" as const]) {
      const t = setup({ status });
      await t.worker.speak("r3", "I can't tell you what to buy or sell. I can show you the price, why it moved, your position and your limits.", API);
      expect(t.speech()).toEqual(["unavailable"]);
      expect(t.errorTone).toHaveBeenCalledTimes(1);
      expect(t.speechSynthesis.speak).not.toHaveBeenCalled();
      expect(FakeAudio.all).toHaveLength(0);
      FakeAudio.all = [];
    }
  });

  it("the advice decline and every other common line play in Glance's voice, fetched once per session", async () => {
    const t = setup();
    for (const line of FIXED_LINES) {
      const p = t.worker.speak(`r-${line.length}`, line, API);
      await flush();
      const a = FakeAudio.all.at(-1)!;
      expect(a.src).toBe("blob:clip"); // the whole clip, from the API's pre-recorded line
      a.onplaying!();
      a.onended!();
      await p;
    }
    const speakRequests = () => t.requests.filter((r) => r.url.includes("/voice/speak?")).length;
    expect(speakRequests()).toBe(FIXED_LINES.length);
    // Again this session: from memory, no request.
    const again = t.worker.speak("again", LINES.noAdvice, API);
    await flush();
    FakeAudio.all.at(-1)!.onplaying!();
    FakeAudio.all.at(-1)!.onended!();
    await again;
    expect(speakRequests()).toBe(FIXED_LINES.length);
    expect(t.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("a stall mid-reply stops it there (a 'cut'): no other voice, no restart", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const p = t.worker.speak("r4", "Tesla is at $375.81, and the market's open. It rose after record deliveries.", API);
      await vi.advanceTimersByTimeAsync(1);
      const a = FakeAudio.all.at(-1)!;
      a.onplaying!();
      a.currentTime = 1.2;
      for (let i = 0; i < 4; i++) {
        t.advance(250);
        await vi.advanceTimersByTimeAsync(250);
      }
      // No progress from here on (the stream stopped): after 2.5s, cut.
      for (let i = 0; i < 12; i++) {
        t.advance(250);
        await vi.advanceTimersByTimeAsync(250);
      }
      await p;
      expect(t.speech()).toEqual(["start", "cut"]);
      expect(t.events.find((e) => e.kind === "voice:speech" && e.type === "cut")).toMatchObject({ t: 1.2 });
      expect(a.paused).toBe(true);
      expect(FakeAudio.all).toHaveLength(1); // not started again
      expect(t.speechSynthesis.speak).not.toHaveBeenCalled();
      expect(t.errorTone).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an audio error after it started is a cut too; before it started, it's 'no voice'", async () => {
    const t = setup();
    const p = t.worker.speak("r5", "Tesla is at $375.81.", API);
    await flush();
    FakeAudio.all[0]!.onplaying!();
    FakeAudio.all[0]!.currentTime = 0.8;
    FakeAudio.all[0]!.onerror!();
    await p;
    expect(t.speech()).toEqual(["start", "cut"]);
    const u = setup();
    const q = u.worker.speak("r6", "Tesla is at $375.81.", API);
    await flush();
    FakeAudio.all.at(-1)!.onerror!();
    await q;
    expect(u.speech()).toEqual(["unavailable"]);
    expect(u.errorTone).toHaveBeenCalledTimes(1);
    expect(u.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("a new voice on the API: the session's common lines are fetched again in it", async () => {
    const t = setup({ voice: "flux-sienna-en" });
    const play = async (id: string) => {
      const p = t.worker.speak(id, LINES.wontTrade, API);
      await flush();
      FakeAudio.all.at(-1)!.onplaying!();
      FakeAudio.all.at(-1)!.onended!();
      await p;
    };
    await play("a");
    await play("b");
    expect(t.requests.filter((r) => r.url.includes("/voice/speak?"))).toHaveLength(1);
    // The API now reports another voice (the status is re-read after its time-to-live).
    t.worker["status"] = null;
    (t.worker as unknown as { status: unknown }).status = null;
    const u = setup({ voice: "aura-2-harmonia-en" });
    (u.worker as unknown as { fixed: Map<string, Blob> }).fixed = (t.worker as unknown as { fixed: Map<string, Blob> }).fixed;
    const p = u.worker.speak("c", LINES.wontTrade, API);
    await flush();
    FakeAudio.all.at(-1)!.onplaying!();
    FakeAudio.all.at(-1)!.onended!();
    await p;
    expect(u.requests.filter((r) => r.url.includes("/voice/speak?"))).toHaveLength(1);
  });
});

describe("voice worker: a reply spoken sentence by sentence", () => {
  const speakUrls = (t: ReturnType<typeof setup>) => t.requests.filter((r) => r.url.includes("/voice/speak?")).map((r) => decodeURIComponent(r.url));

  it("plays the sentences in order, back to back, each later one preloaded in the first one's voice", async () => {
    const t = setup();
    t.worker.speakPart("m1", 0, "Revenue grew twelve percent.", API);
    await flush();
    expect(FakeAudio.all).toHaveLength(1);
    // The first sentence plays as soon as it arrives; the rest haven't been written yet.
    FakeAudio.all[0]!.onplaying!();
    t.worker.speakPart("m1", 1, "The margin was eighteen percent.", API);
    t.worker.speakPart("m1", 2, "Deliveries were a record.", API);
    t.worker.speakEnd("m1", 3);
    await flush();
    // The second sentence is fetched (pinned to the first one's voice) while the first is still playing.
    expect(FakeAudio.all[0]!.src).toBe(`${API}/voice/speak?text=${encodeURIComponent("Revenue grew twelve percent.")}`);
    expect(speakUrls(t)).toEqual([`${API}/voice/speak?text=The margin was eighteen percent.&voice=flux-sienna-en`]);
    FakeAudio.all[0]!.onended!();
    await flush();
    expect(FakeAudio.all).toHaveLength(2);
    expect(FakeAudio.all[1]!.src).toBe("blob:clip"); // already downloaded: no gap
    FakeAudio.all[1]!.onplaying!();
    await flush();
    expect(speakUrls(t).at(-1)).toBe(`${API}/voice/speak?text=Deliveries were a record.&voice=flux-sienna-en`);
    FakeAudio.all[1]!.onended!();
    await flush();
    FakeAudio.all[2]!.onplaying!();
    FakeAudio.all[2]!.onended!();
    await flush();
    expect(t.speech()).toEqual(["start", "part", "part-end", "part", "part-end", "part", "part-end", "end"]);
    expect(t.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("a later sentence its voice can't say (after one retry) stops the reply there: no other voice, the rest stays written", async () => {
    const t = setup({ speak: (u) => (u.includes("&voice=") ? new Response("", { status: 503 }) : undefined) });
    t.worker.speakPart("m2", 0, "Tesla fell this week.", API);
    t.worker.speakPart("m2", 1, "It dropped on Tuesday.", API);
    t.worker.speakEnd("m2", 2);
    await flush();
    FakeAudio.all[0]!.onplaying!();
    await flush();
    FakeAudio.all[0]!.onended!();
    await flush(10);
    const tries = speakUrls(t).filter((u) => u.includes("It dropped"));
    expect(tries).toHaveLength(2); // one retry, same voice
    expect(tries.every((u) => u.endsWith("&voice=flux-sienna-en"))).toBe(true);
    expect(FakeAudio.all).toHaveLength(1); // nothing else played
    expect(t.events.filter((e) => e.kind === "voice:speech").at(-1)).toMatchObject({ type: "cut", part: 1 });
    expect(t.speechSynthesis.speak).not.toHaveBeenCalled();
    expect(t.errorTone).not.toHaveBeenCalled();
  });

  it("a new key press drops the rest of the reply", async () => {
    const t = setup();
    t.worker.speakPart("m3", 0, "One.", API);
    await flush();
    FakeAudio.all[0]!.onplaying!();
    t.worker.hush();
    t.worker.speakPart("m3", 1, "Two.", API);
    await flush();
    expect(FakeAudio.all[0]!.paused).toBe(true);
    expect(speakUrls(t).some((u) => u.includes("Two."))).toBe(false);
  });
});

describe("voice worker: the instant acknowledgment", () => {
  async function ask(text: string) {
    const t = setup({ command: { intent: "ask", symbol: null, amount: null, reply: "" } });
    void t.worker.start("k", "en-US", API, {});
    await flush();
    FakeWS.last.open();
    const stopping = t.worker.stop("k");
    await flush();
    FakeWS.last.reply({ type: "transcript", text });
    await stopping;
    await flush();
    return t.requests.filter((r) => r.url.includes("/voice/speak?")).map((r) => decodeURIComponent(r.url.split("text=")[1]!));
  }

  it("a slow request (Show me, teach, guide, why) gets a pre-recorded 'One sec.' straight away", async () => {
    const said = await ask("show me the key numbers in this article");
    expect(said).toHaveLength(1);
    expect(ACKS as readonly string[]).toContain(said[0]);
  });

  it("the acknowledgments rotate", async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) {
      void t.worker.start(`k${i}`, "en-US", API, {});
      await flush();
      FakeWS.last.open();
      const stopping = t.worker.stop(`k${i}`);
      await flush();
      FakeWS.last.reply({ type: "transcript", text: "why did Tesla drop?" });
      await stopping;
      await flush();
      FakeAudio.all.at(-1)?.onplaying?.();
      FakeAudio.all.at(-1)?.onended?.();
      await flush();
    }
    const acks = t.requests.filter((r) => r.url.includes("/voice/speak?")).map((r) => decodeURIComponent(r.url.split("text=")[1]!)).filter((x) => (ACKS as readonly string[]).includes(x));
    expect(new Set(acks).size).toBe(3);
  });

  it("a price, the portfolio or a buy gets none", async () => {
    for (const q of ["what's Tesla at", "how am I doing", "buy ten dollars of Tesla"]) expect(await ask(q)).toEqual([]);
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

describe("voice worker: conversation mode", () => {
  it("a refresh warms without a reason (no billed AssemblyAI session); the panel opening says so", () => {
    const t = setup();
    t.worker.warm(API);
    t.worker.warm(API, "panel");
    expect(t.requests.map((r) => r.url)).toEqual([`${API}/voice/warm`, `${API}/voice/warm?for=panel&client=${t.worker.client}`]);
    expect(t.worker.client).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });

  it("asks the API for conversation mode with the session's basket names; partials show as the live transcript", async () => {
    const t = setup();
    void t.worker.start("c1", "en-US", API, {}, undefined, { conversation: true, keyterms: ["Tech Giants", "ETFs"] });
    await flush();
    const u = new URL(FakeWS.last.url);
    expect(u.searchParams.get("mode")).toBe("conversation");
    expect(t.requests[0]!.url).toBe(`${API}/voice/warm?for=conversation&client=${t.worker.client}`);
    expect(JSON.parse(u.searchParams.get("keyterms")!)).toEqual(["Tech Giants", "ETFs"]);
    FakeWS.last.open();
    FakeWS.last.reply({ type: "partial", text: "buy ten" });
    FakeWS.last.reply({ type: "partial", text: "buy ten dollars of Palantir" });
    await flush();
    const interim = t.events.filter((e) => e.kind === "voice:event" && e.type === "interim").map((e) => (e as { text: string }).text);
    expect(interim).toEqual(["buy ten", "buy ten dollars of Palantir"]);
  });

  it("the end of the speaker's turn sends it: no key up; the microphone stops, the reply plays, listening ends", async () => {
    const t = setup({ command: { intent: "buy", symbol: "PLTR", amount: "10", reply: "$10 of Palantir. Let me check your limits first." } });
    void t.worker.start("c2", "en-US", API, {}, undefined, { conversation: true });
    await flush();
    FakeWS.last.open();
    FakeCapture.last.chunk(1);
    FakeWS.last.reply({ type: "transcript", text: "Buy $10 of Palantir.", endOfTurn: true });
    FakeWS.last.close(); // the API closes the stream after its transcript
    await flush(12);
    expect(FakeCapture.last.stopped).toBe(true);
    expect(t.types()).toEqual(expect.arrayContaining(["started", "released", "final", "intent"]));
    const command = t.requests.find((r) => r.url.endsWith("/voice/command"))!;
    expect(JSON.parse(String(command.init!.body)).transcript).toBe("Buy $10 of Palantir.");
    expect(FakeWS.last.sent).not.toContain(JSON.stringify({ type: "stop" })); // the stream had already finished
    FakeAudio.all.at(-1)!.onplaying!(); // the reply plays; the session (and listening) ends with it
    await flush();
    expect(t.types().at(-1)).toBe("end");
  });

  it("Escape (abort) mid-turn: the microphone and the stream close, nothing is sent", async () => {
    const t = setup();
    void t.worker.start("c3", "en-US", API, {}, undefined, { conversation: true });
    await flush();
    FakeWS.last.open();
    FakeCapture.last.chunk(1);
    t.worker.abort("c3");
    await flush();
    expect(FakeCapture.last.stopped).toBe(true);
    expect(FakeWS.last.readyState).toBe(3);
    expect(t.requests.some((r) => r.url.endsWith("/voice/command"))).toBe(false);
    expect(t.types().at(-1)).toBe("end");
  });

  it("hold-to-talk is unchanged: no mode on the stream, and an end-of-turn transcript alone doesn't stop the capture", async () => {
    const t = setup();
    void t.worker.start("h1", "en-US", API, {});
    await flush();
    expect(FakeWS.last.url).toBe(`ws://localhost:8790/voice/stream?client=${t.worker.client}`);
    FakeWS.last.open();
    FakeWS.last.reply({ type: "partial", text: "what's" });
    await flush();
    expect(FakeCapture.last.stopped).toBe(false);
  });
});
