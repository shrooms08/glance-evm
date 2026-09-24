/**
 * A stand-in Glance API for the setup-journey check: the same routes and response shapes the extension reads, with the
 * chain mocked. Nothing here touches a chain or sends a transaction: the trade response is canned. It also serves the
 * fixture news article the check opens.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

/** The user's own vault in this check (the chain is mocked: nothing is on chain). */
export const USER_VAULT = "0x00000000000000000000000000000000000e2e01";
export const FAKE_TX = `0x${"e2e0".repeat(16)}`;
const NOW = () => Math.floor(Date.now() / 1000);
const amount = (value: string, decimals = 6) => ({ raw: String(Math.round(Number(value) * 10 ** decimals)), value, formatted: `$${Number(value).toFixed(2)}` });
const price = { raw: "38000000000", decimals: 8, value: "380" };

const stocks = [
  { symbol: "TSLA", name: "Tesla", legalName: "Tesla, Inc.", aliases: ["Tesla"], token: "0x0000000000000000000000000000000000000a01", tokenDecimals: 18, tokenReal: true, feedReal: false, priceSourceKind: "mainnet-mirror" },
  { symbol: "AMZN", name: "Amazon", legalName: "Amazon.com, Inc.", aliases: ["Amazon"], token: "0x0000000000000000000000000000000000000a02", tokenDecimals: 18, tokenReal: true, feedReal: false, priceSourceKind: "mainnet-mirror" },
];

const window24h = { used: amount("0"), limit: amount("500"), remaining: amount("500"), nextReleaseInSeconds: null, clearsInSeconds: null };
const vault = {
  address: USER_VAULT,
  agentActive: true,
  agentExpiresInSeconds: 20 * 86_400,
  paused: false,
  limits: { perTrade: amount("100"), dailyBuy: amount("500"), dailySell: amount("500"), weekendCap: "25%", weekendCapBps: 2_500 },
  effectiveCaps: { OPEN: { perTrade: amount("100"), dailyBuy: amount("500"), dailySell: amount("500") }, CLOSED: { perTrade: amount("25"), dailyBuy: amount("125"), dailySell: amount("125") } },
  buyWindow: window24h,
  sellWindow: window24h,
  balances: { usdg: amount("90"), invested: amount("10"), total: amount("100") },
  positions: [],
};

export interface MockApi {
  url: string;
  trades: unknown[];
  /** What GET /session/status answers for the check's vault: flipped to linked once the owner "signs". */
  setLinked(linked: boolean): void;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s;
}

export async function startMockApi(port = 8797): Promise<MockApi> {
  const trades: unknown[] = [];
  let linked = false;
  const article = readFileSync(resolve(import.meta.dirname, "fixtures/article.html"), "utf8");
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
    res.end(JSON.stringify(data));
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;
    if (req.method === "OPTIONS") return json(res, 204, null);
    if (path === "/article.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(article);
    }
    if (path === "/health") return json(res, 200, { ok: true, chainId: 46_630, expectedChainId: 46_630, blockNumber: "1", feeds: [{ symbol: "TSLA", price, updatedAt: NOW() - 60, ageSeconds: 60, age: "1 minute", marketState: "OPEN", source: "mainnet-mirror", lastWrite: null }] });
    if (path === "/catalog") return json(res, 200, { chainId: 46_630, stocks });
    if (path === "/resolve") {
      const { text } = JSON.parse(await body(req)) as { text: string };
      const matches = [];
      for (const s of stocks) {
        for (let i = text.indexOf(s.name); i >= 0; i = text.indexOf(s.name, i + 1)) matches.push({ symbol: s.symbol, text: s.name, start: i, end: i + s.name.length, kind: "name", source: "dictionary" });
      }
      return json(res, 200, { source: "dictionary", matches });
    }
    if (path === "/resolve/names") return json(res, 200, { asked: 0, count: 0, names: [] });
    if (path.startsWith("/price/")) {
      const symbol = path.split("/")[2]!;
      return json(res, 200, { symbol, name: stocks.find((s) => s.symbol === symbol)?.name ?? symbol, price, updatedAt: NOW() - 60, ageSeconds: 60, age: "1 minute", marketState: "OPEN", priceSourceKind: "mainnet-mirror" });
    }
    if (path.startsWith("/vault/")) return json(res, 200, vault);
    if (path === "/quote") {
      const q = url.searchParams;
      return json(res, 200, {
        vault: q.get("vault"),
        symbol: q.get("symbol"),
        side: q.get("side"),
        amountIn: amount(q.get("amount") ?? "10"),
        deskQuote: { raw: "26315789473684210", value: "0.026315", formatted: "0.0263 TSLA" },
        oracleImplied: { raw: "26315789473684210", value: "0.026315", formatted: "0.0263 TSLA" },
        spreadBps: 10,
        spread: "0.10%",
        minOut: { raw: "26000000000000000", value: "0.026", formatted: "0.0260 TSLA" },
        price,
        marketState: "OPEN",
        priceAgeSeconds: 60,
        preflight: { ok: true, simulatedAs: "0x0000000000000000000000000000000000000abc" },
      });
    }
    if (path === "/trade" && req.method === "POST") {
      const b = JSON.parse(await body(req)) as { symbol: string };
      trades.push(b);
      return json(res, 200, {
        txHash: FAKE_TX,
        explorerUrl: `https://explorer.testnet.chain.robinhood.com/tx/${FAKE_TX}`,
        symbol: b.symbol,
        side: "buy",
        filled: { usdgIn: amount("10"), tokensOut: { raw: "26315789473684210", value: "0.026315", formatted: "0.0263 TSLA" } },
        balancesAfter: {},
      });
    }
    if (path === "/voice/status") return json(res, 200, { transcription: "none", speech: "none", intent: "rules", available: { transcription: false, speech: false, stream: false }, warnings: [], resting: { transcription: false, speech: false } });
    if (path === "/voice/warm") return json(res, 200, { ok: true });
    if (path.startsWith("/chart/")) return json(res, 404, { error: { code: "NOT_FOUND", message: "No chart in this check." } });
    if (path.startsWith("/why/")) return json(res, 404, { error: { code: "NOT_FOUND", message: "No news in this check." } });
    if (path.startsWith("/session/status")) return json(res, 200, linked ? { linked: true, expiresAt: NOW() + 30 * 86_400, linkedAt: NOW() } : { linked: false, reason: "unknown" });
    if (path === "/faucet") return json(res, 200, { enabled: false, amountEth: null, usdg: { enabled: false, amount: null }, stocked: { gas: false, usdg: false } });
    return json(res, 404, { error: { code: "NOT_FOUND", message: "No such endpoint." } });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://localhost:${port}`, trades, setLinked: (v) => void (linked = v), close: () => new Promise((r) => server.close(() => r())) };
}
