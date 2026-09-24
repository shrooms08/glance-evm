/**
 * Voice latency, key release to Glance's first word, through the real pipeline of a running API (the extension's own
 * steps, simulated): each question is spoken once in Sienna and cached as 16 kHz PCM, then streamed to /voice/stream
 * in real time (40 ms slices, the stream opened at "key down"), and every stage is timed from the release:
 *
 *   transcript     the final transcript arrives
 *   intent         /voice/command answers (rules or Claude)
 *   firstSentence  Show me only: the first complete sentence (streamed) or the whole answer (not streamed)
 *   ttsFirstByte   /voice/speak's first audio byte for the reply (the extension starts playing on it)
 *   card           "buy" only: the confirm card's /quote has answered
 *
 * Logs timings only, never text. Usage:
 *   pnpm exec tsx --env-file-if-exists=.env scripts/latency.ts --api http://localhost:8790 --runs 5 --cases price,portfolio
 * Writes JSON to --out (default stdout). Uses DEEPGRAM_API_KEY only to make the spoken questions once (cached in --dir).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const API = arg("api", "http://localhost:8790");
const RUNS = Number(arg("runs", "5"));
const DIR = arg("dir", join(process.cwd(), ".cache", "latency"));
const OUT = arg("out", "");
const MODE = arg("mode", "before");
const VAULT = arg("vault", "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113");

export const CASES: Record<string, { say: string; kind: "simple" | "buy" | "showme" }> = {
  price: { say: "What's Tesla at?", kind: "simple" },
  portfolio: { say: "How am I doing?", kind: "simple" },
  buy: { say: "Buy ten dollars of Tesla.", kind: "buy" },
  advice: { say: "Should I buy Tesla?", kind: "simple" },
  showme: { say: "Show me the key numbers in this article.", kind: "showme" },
};
const cases = arg("cases", Object.keys(CASES).join(",")).split(",");

mkdirSync(DIR, { recursive: true });

/** The question as 16 kHz mono PCM, spoken once by Deepgram and cached. */
async function utterance(text: string): Promise<Uint8Array> {
  const file = join(DIR, `${text.replace(/\W+/g, "-").toLowerCase()}.pcm`);
  if (existsSync(file)) return new Uint8Array(readFileSync(file));
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY is needed once, to make the spoken questions");
  const res = await fetch("https://api.deepgram.com/v1/speak?model=aura-2-harmonia-en&encoding=linear16&sample_rate=16000&container=none", {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Deepgram answered ${res.status}`);
  const pcm = new Uint8Array(await res.arrayBuffer());
  // Half a second of silence before and after, like a person holding the key.
  const pad = new Uint8Array(16_000);
  const out = new Uint8Array(pad.length * 2 + pcm.length);
  out.set(pcm, pad.length);
  writeFileSync(file, out);
  return out;
}

/** A real article's text, for Show me (Wikipedia's Tesla, Inc. article, fetched once). */
async function article(): Promise<{ title: string; host: string; text: string }> {
  const file = join(DIR, "article.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as { title: string; host: string; text: string };
  const res = await fetch("https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&titles=Tesla,_Inc.&format=json", { headers: { "user-agent": "Glance latency check" } });
  const body = (await res.json()) as { query: { pages: Record<string, { extract: string }> } };
  const text = Object.values(body.query.pages)[0]!.extract.slice(0, 24_000);
  const a = { title: "Tesla, Inc. - Wikipedia", host: "en.wikipedia.org", text };
  writeFileSync(file, JSON.stringify(a));
  return a;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Time to the first byte of a GET body. */
async function firstByte(url: string, t0: number): Promise<number> {
  const res = await fetch(url);
  const reader = res.body!.getReader();
  await reader.read();
  const at = performance.now() - t0;
  void reader.cancel().catch(() => {});
  return at;
}

async function run(name: string): Promise<Record<string, number>> {
  const c = CASES[name]!;
  const pcm = await utterance(c.say);
  const t: Record<string, number> = {};
  // Key down: warm the API and open the stream, as the extension does.
  void fetch(`${API}/voice/warm`, { method: "POST" }).catch(() => {});
  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/voice/stream?vault=${VAULT}`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("stream didn't open"));
  });
  const transcript = new Promise<string>((resolve) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; text?: string };
      if (msg.type === "transcript") resolve(msg.text ?? "");
    };
  });
  // Speak in real time: 40 ms slices (1,280 bytes at 16 kHz, 16-bit).
  for (let i = 0; i < pcm.length; i += 1_280) {
    ws.send(pcm.slice(i, i + 1_280));
    await sleep(40);
  }
  const t0 = performance.now(); // key release
  ws.send(JSON.stringify({ type: "stop" }));
  const text = await transcript;
  t.transcript = performance.now() - t0;
  ws.close();

  const page = c.kind === "showme" ? await article() : undefined;
  const cmd = await fetch(`${API}/voice/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: text, context: { host: page?.host ?? "news.example" }, vault: VAULT }),
  });
  const intent = (await cmd.json()) as { intent: string; reply: string; symbol: string | null; amount: string | null };
  t.intent = performance.now() - t0;

  if (intent.intent === "ask" || c.kind === "showme") {
    const res = await fetch(`${API}/showme`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: text, surface: "page", page: { ...page, companies: ["TSLA"] } }),
    });
    const a = (await res.json()) as { spoken: string };
    t.firstSentence = performance.now() - t0;
    t.ttsFirstByte = await firstByte(`${API}/voice/speak?text=${encodeURIComponent(a.spoken)}`, t0);
    return t;
  }
  const speak = intent.reply ? firstByte(`${API}/voice/speak?text=${encodeURIComponent(intent.reply)}`, t0) : Promise.resolve(Number.NaN);
  if (c.kind === "buy" && intent.symbol) {
    const card = fetch(`${API}/quote?vault=${VAULT}&symbol=${intent.symbol}&side=buy&amount=${intent.amount ?? "10"}`).then(async (r) => {
      await r.arrayBuffer();
      return performance.now() - t0;
    });
    [t.ttsFirstByte, t.card] = await Promise.all([speak, card]);
  } else t.ttsFirstByte = await speak;
  return t;
}

const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.floor(s.length / 2)]!) : null;
};

const results: Record<string, { runs: Array<Record<string, number>>; median: Record<string, number | null> }> = {};
for (const name of cases) {
  const runs: Array<Record<string, number>> = [];
  for (let i = 0; i < RUNS; i++) {
    runs.push(await run(name));
    await sleep(1_500);
  }
  const keys = [...new Set(runs.flatMap((r) => Object.keys(r)))];
  results[name] = { runs: runs.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)]))), median: Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]!))])) };
  console.error(`${MODE} ${name}: ${JSON.stringify(results[name]!.median)}`);
}
const json = JSON.stringify({ mode: MODE, api: API, runs: RUNS, results }, null, 2);
if (OUT) writeFileSync(OUT, json);
else console.log(json);
