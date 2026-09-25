/**
 * Speech recognition compared on real audio: five commands spoken by a TTS voice (macOS `say`, Samantha, recorded as
 * 16 kHz 16-bit mono WAV in test/fixtures/voice), streamed through a running Glance API exactly as the extension does
 * (the stream opened at "key down", 40 ms slices in real time, {"type":"stop"} at "release"), N runs each.
 *
 *   transcript   key release to the final transcript
 *   firstAudio   key release to the reply's first audio byte (transcript, then /voice/command, then GET /voice/speak)
 *   heard        the words (reference words found), and what the API understood: the intent, ticker and amount
 *
 * Run it against one API per provider (STT_PROVIDER=assemblyai / deepgram), then compare the JSON. Live and opt-in:
 * it runs only with VOICE_LIVE_TESTS=1, against an API started with VOICE_LIVE_TESTS=1 (so its AssemblyAI seconds go
 * to the test counter, never the daily cap; /voice/status says "metering": "test"), and at most 10 real runs:
 *   VOICE_LIVE_TESTS=1 pnpm exec tsx scripts/stt-compare.ts --api http://localhost:8795 --label keydown --runs 1
 * The API's own logs carry timings and lengths only; this report has the fixture transcripts (TTS phrases, not users).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const API = arg("api", "http://localhost:8790");
const RUNS = Number(arg("runs", "1"));
const LABEL = arg("label", "api");
const OUT = arg("out", "");
/**
 * How the AssemblyAI session is opened:
 *   early    a session opened 2s before the key goes down (what the panel opening used to do)
 *   keydown  /voice/warm?for=key-down as the key goes down, alongside the stream (the extension now)
 *   cold     no warm at all: the stream opens its own session
 */
const WARM = arg("warm", "keydown");
/** Real sessions cost real seconds: never more than this many runs in one go. */
export const MAX_REAL_RUNS = 10;
const CLIENT = `bench-${Math.random().toString(36).slice(2, 10)}`;
/**
 * Pause between runs (ms). AssemblyAI's free tier opens 5 new sessions a minute (paid: 100+; over it, close 1008 "Too
 * many concurrent sessions"), so a fair AssemblyAI measurement on a free key spaces runs about 13s apart.
 */
const GAP = Number(arg("gap", "400"));
const DIR = join(import.meta.dirname, "../test/fixtures/voice");

export interface Case {
  file: string;
  say: string;
  /** What the API should understand from it. */
  expect: { intent: string; symbol?: string | null; amount?: string | null; symbols?: string[] };
}
export const STT_CASES: Case[] = [
  { file: "tesla-price", say: "What's Tesla at?", expect: { intent: "price", symbol: "TSLA" } },
  { file: "buy-palantir", say: "Buy ten dollars of Palantir.", expect: { intent: "buy", symbol: "PLTR", amount: "10" } },
  { file: "how-am-i-doing", say: "How am I doing?", expect: { intent: "portfolio" } },
  { file: "compare-tesla-amd", say: "Compare Tesla and AMD this week.", expect: { intent: "compare", symbols: ["TSLA", "AMD"] } },
  { file: "buy-etf-basket", say: "Buy twenty dollars of the ETFs basket.", expect: { intent: "basket-buy", amount: "20" } },
];

/** The PCM samples of a WAV file (any chunk layout: afconvert adds a padding chunk before "data"). */
export function wavPcm(buf: Uint8Array): Uint8Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 12;
  while (at + 8 <= buf.byteLength) {
    const id = String.fromCharCode(...buf.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (id === "data") return buf.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

/** Lower case, apostrophes dropped ("ETF's" -> "etfs"), "$10" read as "10 dollars" (formatted finals write amounts so). */
const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\$(\d+)/g, "$1 dollars")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
/** The share of the reference's words found in what was heard (numbers match as digits or words: "ten" = "10"). */
export function wordAccuracy(reference: string, heard: string): number {
  const NUM: Record<string, string> = { ten: "10", twenty: "20" };
  const norm = (w: string) => NUM[w] ?? w;
  const got = new Set(words(heard).map(norm));
  const ref = words(reference).map(norm);
  return ref.filter((w) => got.has(w)).length / ref.length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN;
};

async function once(c: Case, pcm: Uint8Array) {
  const warm = () => fetch(`${API}/voice/warm?for=key-down&client=${CLIENT}`, { method: "POST" });
  if (WARM === "early") {
    await warm();
    await sleep(2_000);
  }
  // Key down: the extension warms and opens the stream at the same moment.
  if (WARM === "keydown") void warm();
  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/voice/stream?client=${CLIENT}`);
  ws.binaryType = "arraybuffer";
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("stream didn't open"));
  });
  const transcript = new Promise<{ text: string; provider?: string }>((resolve) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; text?: string; provider?: string; message?: string };
      if (msg.type === "transcript") resolve({ text: msg.text ?? "", provider: msg.provider });
      if (msg.type === "error") resolve({ text: "", provider: `error: ${msg.message}` });
    };
  });
  await opened;
  // "Key down": 300 ms of silence, the words, 250 ms of silence, then the release, in 40 ms slices in real time.
  const silence = (ms: number) => new Uint8Array(ms * 32);
  const audio = new Uint8Array([...silence(300), ...pcm, ...silence(250)]);
  const slice = 1_280;
  const t0 = performance.now();
  for (let at = 0, i = 0; at < audio.length; at += slice, i++) {
    ws.send(audio.subarray(at, at + slice));
    const due = t0 + (i + 1) * 40;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
  }
  const released = performance.now();
  ws.send(JSON.stringify({ type: "stop" }));
  const t = await transcript;
  const transcriptMs = performance.now() - released;
  const cmd = (await (await fetch(`${API}/voice/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcript: t.text || "(nothing)", context: {} }) })).json()) as {
    intent: string;
    symbol: string | null;
    amount: string | null;
    symbols?: string[];
    reply: string;
  };
  let firstAudioMs: number | null = null;
  if (cmd.reply?.trim()) {
    const res = await fetch(`${API}/voice/speak?text=${encodeURIComponent(cmd.reply)}`);
    const reader = res.body!.getReader();
    await reader.read();
    firstAudioMs = performance.now() - released;
    await reader.cancel();
  }
  const e = c.expect;
  const understood = cmd.intent === e.intent && (e.symbol === undefined || cmd.symbol === e.symbol) && (e.amount === undefined || cmd.amount === e.amount) && (e.symbols === undefined || JSON.stringify(cmd.symbols) === JSON.stringify(e.symbols));
  return { text: t.text, provider: t.provider, transcriptMs, firstAudioMs, understood, intent: { intent: cmd.intent, symbol: cmd.symbol, amount: cmd.amount, symbols: cmd.symbols }, accuracy: wordAccuracy(c.say, t.text) };
}

if (process.argv[1]?.endsWith("stt-compare.ts")) {
  if (process.env.VOICE_LIVE_TESTS !== "1") {
    console.error("stt-compare: live runs spend real AssemblyAI and Deepgram seconds. Run with VOICE_LIVE_TESTS=1.");
    process.exit(1);
  }
  if (RUNS * STT_CASES.length > MAX_REAL_RUNS) {
    console.error(`stt-compare: ${RUNS * STT_CASES.length} runs asked for; at most ${MAX_REAL_RUNS} real runs at a time.`);
    process.exit(1);
  }
  const status = (await (await fetch(`${API}/voice/status`)).json()) as { stt?: { provider: string; metering?: string } | null };
  if (status.stt?.provider === "assemblyai" && status.stt.metering !== "test") {
    console.error("stt-compare: that API counts AssemblyAI seconds against the daily cap. Start it with VOICE_LIVE_TESTS=1.");
    process.exit(1);
  }
  const report: Record<string, unknown> = {};
  for (const c of STT_CASES) {
    const pcm = wavPcm(new Uint8Array(readFileSync(join(DIR, `${c.file}.wav`))));
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      runs.push(await once(c, pcm));
      await sleep(GAP);
    }
    report[c.file] = {
      say: c.say,
      providers: [...new Set(runs.map((r) => r.provider))],
      transcriptMsMedian: Math.round(median(runs.map((r) => r.transcriptMs))),
      firstAudioMsMedian: runs.some((r) => r.firstAudioMs !== null) ? Math.round(median(runs.flatMap((r) => (r.firstAudioMs === null ? [] : [r.firstAudioMs])))) : null,
      understood: `${runs.filter((r) => r.understood).length}/${runs.length}`,
      wordAccuracy: +median(runs.map((r) => r.accuracy)).toFixed(2),
      heard: [...new Set(runs.map((r) => r.text))],
      intent: runs[0]?.intent,
    };
    console.log(LABEL, c.file, JSON.stringify(report[c.file]));
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ label: LABEL, api: API, runs: RUNS, at: new Date().toISOString(), report }, null, 1));
}
