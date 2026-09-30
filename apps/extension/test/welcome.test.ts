/**
 * The Welcome page's words and rules (lib/welcome.ts), the hotkey tip, and a check that nothing from another product
 * ships in the extension.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { celebrate, LEASH, stockList, WELCOME, welcomeLines, welcomeStage } from "../lib/welcome";
import { hotkeyTip, HOTKEY_TIP_LOADS, hotkeyTips, takeHotkeyTip } from "../lib/onboarding";

describe("the Welcome page", () => {
  it("has no em or en dashes in any line", () => {
    for (const line of welcomeLines(["TSLA", "AMZN", "PLTR"])) expect(line).not.toMatch(/[‒-―]/);
  });

  it("says the leash: $100 a trade, $500 a day, 25% of that while the market is closed", () => {
    expect(LEASH).toEqual({ perTrade: 100, perDay: 500, closedPct: 25 });
    expect(WELCOME.leash.tiles).toEqual(["$100 / trade", "$500 / day", "25% while closed"]);
    expect(WELCOME.almost.body(50, ["TSLA"])).toContain("up to $100 at a time and $500 a day, 25% of that while the market is closed");
  });

  it("names the stocks from the catalog it is given, not a fixed list", () => {
    expect(stockList(["TSLA", "AMZN", "PLTR"])).toBe("TSLA, AMZN and PLTR");
    expect(WELCOME.almost.body(25, ["AMD", "NFLX"])).toContain("I can only trade AMD and NFLX in that vault");
  });

  it("says Robinhood Chain testnet and Paxos USDG, and the three keys", () => {
    expect(WELCOME.fund.note).toBe("Test money on Robinhood Chain testnet, in Paxos USDG. No real funds move.");
    expect(WELCOME.tryIt.body("⌥ G", "⌥ V", "Tesla").join("")).toBe(
      "Open any article about a company and press ⌥ G, or tap the orb in the corner of the page. I'll offer to buy it. You can also hold ⌥ V and say “buy ten dollars of Tesla”. Escape stops me.",
    );
  });

  it("shows sign-in, then the setup steps, then All set, from what the console reported", () => {
    expect(welcomeStage({ setupComplete: false, wallet: false })).toBe("signin");
    expect(welcomeStage({ setupComplete: false, wallet: true })).toBe("account");
    expect(welcomeStage({ setupComplete: true, wallet: true })).toBe("tryit");
  });

  it("celebrates the first answer (\"That's a glance.\") only when it came after the page opened, or just before", () => {
    const opened = 1_000_000;
    expect(celebrate(null, opened)).toBe(false);
    expect(celebrate(opened + 5_000, opened)).toBe(true);
    expect(celebrate(opened - 30_000, opened)).toBe(true);
    expect(celebrate(opened - 120_000, opened)).toBe(false);
    expect(WELCOME.tryIt.celebrated).toBe("That's a glance.");
  });
});

describe("the hotkey tip by the orb", () => {
  it("reads like GLANCE by Heylana's, with this product's keys", () => {
    expect(hotkeyTip("⌥ G", "⌥ V")).toBe("⌥ G glance · hold ⌥ V to talk · Esc stops");
  });

  it("shows on the first 3 page loads, then never again", async () => {
    await hotkeyTips.setValue(0);
    const seen: boolean[] = [];
    for (let i = 0; i < 5; i++) seen.push(await takeHotkeyTip());
    expect(HOTKEY_TIP_LOADS).toBe(3);
    expect(seen).toEqual([true, true, true, false, false]);
  });
});

describe("what ships in the extension", () => {
  const root = join(import.meta.dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (["node_modules", ".output", ".output-e2e-real", ".wxt", "test", "e2e", "fonts", "sfx", "icon"].includes(f)) return [];
      return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css|html|json|js)$/.test(f) ? [p] : [];
    });

  it("names nothing from another product: no Solana, SKR, Seeker, Phantom, xStocks, Pyth, Jupiter or Seed Vault", () => {
    const WORDS = /\b(solana|skr|seeker|phantom|xstocks|pyth|jupiter|seed vault)\b/i;
    const hits = ["lib", "components", "entrypoints", "public", "package.json", "wxt.config.ts"]
      .flatMap((p) => {
        const full = join(root, p);
        return statSync(full).isDirectory() ? files(full) : [full];
      })
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => WORDS.test(line))
          .map(({ line, i }) => `${relative(root, f)}:${i + 1}: ${line.trim().slice(0, 80)}`),
      );
    expect(hits).toEqual([]);
  });
});
