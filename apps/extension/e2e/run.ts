/**
 * One command for the judge-journey check:  pnpm --filter extension e2e
 *
 * Builds the extension into .output-e2e (with the e2e console's origin allowed) and the console into .next-e2e (both
 * separate from your own builds, so nothing you have loaded or running is touched), starts that console on port 3999,
 * runs the Playwright test (which starts its own mock API on port 8797), and stops the console. Needs Playwright's
 * Chromium (npx playwright install chromium, once). No real transactions, no keys, no Claude calls.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const here = import.meta.dirname;
const extension = resolve(here, "..");
const console_ = resolve(here, "../../console");
const CONSOLE_PORT = "3999";
const API_PORT = "8797";

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

// Next rewrites these two files for its build folder: put them back afterwards, so the check leaves no changes behind.
const touched = ["tsconfig.json", "next-env.d.ts"].map((f) => resolve(console_, f));
const saved = touched.map((f) => readFileSync(f, "utf8"));

let server: ChildProcess | null = null;
try {
  console.log("e2e: building the extension (.output-e2e)");
  run("pnpm", ["exec", "wxt", "build"], extension, { WXT_OUT_DIR: ".output-e2e", WXT_CONSOLE_ORIGINS: `http://localhost:3000,http://localhost:${CONSOLE_PORT}` });
  console.log("e2e: building the console (.next-e2e)");
  run("pnpm", ["exec", "next", "build"], console_, { NEXT_DIST_DIR: ".next-e2e", NEXT_PUBLIC_GLANCE_API_URL: `http://localhost:${API_PORT}` });
  console.log(`e2e: starting the console on ${CONSOLE_PORT}`);
  server = spawn("pnpm", ["exec", "next", "start", "--port", CONSOLE_PORT], { cwd: console_, stdio: "ignore", env: { ...process.env, NEXT_DIST_DIR: ".next-e2e" } });
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`http://localhost:${CONSOLE_PORT}/install`).then((r) => r.ok, () => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  run("pnpm", ["exec", "playwright", "test"], extension, { E2E_CONSOLE_URL: `http://localhost:${CONSOLE_PORT}`, E2E_API_PORT: API_PORT });
} finally {
  server?.kill();
  touched.forEach((f, i) => writeFileSync(f, saved[i]!));
}
