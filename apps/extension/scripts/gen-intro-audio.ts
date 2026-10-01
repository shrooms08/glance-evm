/**
 * One-off: renders the Welcome page's intro (lib/intro.ts) in Glance's own voice and writes
 *   public/intro/line-01.mp3 … line-09.mp3   and   public/intro/manifest.json (each line's text, length and size)
 *
 *   GLANCE_API=http://localhost:8792 node scripts/gen-intro-audio.ts
 *
 * It asks a running Glance API (GET /voice/speak, pinned to the product's voice), so the keys stay with the API's own
 * environment and are never read or printed here. Over 600 KB in all, every line is re-encoded mono at 48 kbps.
 * Needs ffprobe (and ffmpeg for a re-encode).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { INTRO_LINES, introDurationMs, introFile, type IntroManifest } from "../lib/intro.ts";

const API = (process.env.GLANCE_API ?? "http://localhost:8792").replace(/\/+$/, "");
const VOICE = process.env.INTRO_VOICE ?? "flux-sienna-en";
const OUT = resolve(import.meta.dirname, "../public/intro");
const MAX_BYTES = 600 * 1024;

const durationMs = (file: string) =>
  Math.round(Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]).toString().trim()) * 1000);

mkdirSync(OUT, { recursive: true });
const files: string[] = [];
for (const [i, line] of INTRO_LINES.entries()) {
  const res = await fetch(`${API}/voice/speak?${new URLSearchParams({ text: line.spoken, voice: VOICE })}`);
  if (!res.ok) throw new Error(`line ${i + 1}: the API answered ${res.status}`);
  const voice = res.headers.get("x-voice");
  if (voice !== VOICE) throw new Error(`line ${i + 1}: spoken by ${voice ?? "?"}, not ${VOICE}`);
  const file = resolve(OUT, introFile(i).replace(/^\/intro\//, ""));
  writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
  files.push(file);
  console.log(`line ${i + 1}: ${statSync(file).size} bytes`);
}

let total = files.reduce((s, f) => s + statSync(f).size, 0);
if (total > MAX_BYTES) {
  console.log(`${total} bytes is over ${MAX_BYTES}: re-encoding mono at 48 kbps`);
  for (const f of files) {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", f, "-ac", "1", "-b:a", "48k", `${f}.tmp.mp3`]);
    writeFileSync(f, readFileSync(`${f}.tmp.mp3`));
    execFileSync("rm", [`${f}.tmp.mp3`]);
  }
  total = files.reduce((s, f) => s + statSync(f).size, 0);
}

const manifest: IntroManifest = {
  voice: VOICE,
  lines: INTRO_LINES.map((l, i) => ({ file: introFile(i), caption: l.caption, spoken: l.spoken, durationMs: durationMs(files[i]!), bytes: statSync(files[i]!).size })),
};
writeFileSync(resolve(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`intro: ${files.length} lines, ${total} bytes, ${(introDurationMs(manifest) / 1000).toFixed(1)}s with the pauses`);
