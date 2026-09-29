/**
 * pnpm --filter extension e2e:real
 *
 * Builds the extension into .output-e2e-real (with every site's host permission, standing in for the ⌥G press a person
 * makes, so the screenshot fallback can run), starts a local Glance API on port 8791 with NO agent, faucet or keeper
 * key (nothing can send a transaction; it reads its own .env for the Claude and quote keys), runs e2e/charts.real.ts,
 * and stops the API.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = import.meta.dirname;
const extension = resolve(here, "..");
const apiDir = resolve(here, "../../api");
const PORT = "8791";

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

let api: ChildProcess | null = null;
try {
  console.log("e2e:real: building the extension (.output-e2e-real)");
  run("pnpm", ["exec", "wxt", "build"], extension, { WXT_OUT_DIR: ".output-e2e-real", WXT_E2E_ALL_SITES: "1" });
  console.log(`e2e:real: starting a local API on ${PORT} (no agent, faucet or keeper key)`);
  const env = { ...process.env, PORT, AGENT_PRIVATE_KEY: "", FAUCET_PRIVATE_KEY: "", KEEPER_IN_PROCESS: "", DATA_DIR: mkdtempSync(join(tmpdir(), "glance-real-api-")) };
  delete (env as Record<string, string | undefined>).KEEPER_PRIVATE_KEY;
  api = spawn("pnpm", ["exec", "tsx", "--env-file-if-exists=.env", "src/index.ts"], { cwd: apiDir, stdio: "ignore", env });
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`http://localhost:${PORT}/health`).then((r) => r.ok, () => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  run("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts"], extension, { E2E_REAL_API: `http://localhost:${PORT}` });
} finally {
  api?.kill();
  // The cases' rows, merged into docs/qa/chart-annotate.json (in the cases' order).
  const qa = resolve(here, "../../../docs/qa");
  const rows = readdirSync(qa).filter((f) => f.startsWith(".chart-annotate-") && f.endsWith(".json")).map((f) => JSON.parse(readFileSync(resolve(qa, f), "utf8")) as { site: string; symbol: string });
  const order = ["tradingview:HOG", "tradingview:TSLA", "tradingview:NVDA", "yahoo:TSLA"];
  rows.sort((a, b) => order.indexOf(`${a.site}:${a.symbol}`) - order.indexOf(`${b.site}:${b.symbol}`));
  if (rows.length) writeFileSync(resolve(qa, "chart-annotate.json"), `${JSON.stringify(rows, null, 2)}\n`);
  for (const f of readdirSync(qa)) if (f.startsWith(".chart-annotate-")) rmSync(resolve(qa, f));
}
