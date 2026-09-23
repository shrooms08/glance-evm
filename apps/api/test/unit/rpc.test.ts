import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  LimitExceededRpcError,
  RpcRequestError,
  TimeoutError,
  createPublicClient,
  parseAbi,
} from "viem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { chainTransport } from "../../src/chain.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { isRpcTrouble, redactUrl, RPC_TROUBLE_MESSAGE, rpcUrls } from "../../src/rpc.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const VAULT = "0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D";
const abi = parseAbi(["function owner() view returns (address)"]);

const timeout = () => new TimeoutError({ body: {}, url: "https://rpc.example" });
const http502 = () => new HttpRequestError({ url: "https://rpc.example", status: 502, body: {} });
const rateLimited = () => new LimitExceededRpcError(new RpcRequestError({ body: {}, url: "https://rpc.example", error: { code: -32005, message: "rate limited" } }));
const zeroData = () =>
  new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: "owner" }), { abi, functionName: "owner", contractAddress: VAULT });
const reverted = () =>
  new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi, functionName: "owner", message: "reverted" }), {
    abi,
    functionName: "owner",
    contractAddress: VAULT,
  });

describe("isRpcTrouble", () => {
  it.each([
    ["a timeout", timeout],
    ["an HTTP 502 from the RPC", http502],
    ["a rate limit", rateLimited],
    ["fetch failed", () => new TypeError("fetch failed")],
    ["a reset connection", () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["a timeout inside a contract call", () => new ContractFunctionExecutionError(timeout(), { abi, functionName: "owner", contractAddress: VAULT })],
  ])("%s is RPC trouble", (_, make) => {
    expect(isRpcTrouble(make())).toBe(true);
  });

  it.each([
    ["a call that returned no data (not a vault)", zeroData],
    ["a revert (the chain answered)", reverted],
    ["an ordinary bug", () => new Error("x is undefined")],
  ])("%s is not", (_, make) => {
    expect(isRpcTrouble(make())).toBe(false);
  });
});

describe("RPC endpoints", () => {
  it("RPC_URL first, then the fallbacks, without duplicates", () => {
    expect(rpcUrls({ RPC_URL: "https://a.example", RPC_FALLBACK_URLS: "https://b.example, https://a.example,https://c.example" })).toEqual([
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ]);
    expect(loadConfig({}).RPC_FALLBACK_URLS).toBe("https://rpc.testnet.chain.robinhood.com");
    expect(() => loadConfig({ RPC_FALLBACK_URLS: "not a url" })).toThrow(/RPC_FALLBACK_URLS/);
  });

  it("logs never show an endpoint's token", () => {
    expect(redactUrl("https://still-cool-lake.robinhood-testnet.quiknode.pro/abc123secret/")).toBe("https://still-cool-lake.robinhood-testnet.quiknode.pro/…");
    expect(redactUrl("https://rpc.testnet.chain.robinhood.com")).toBe("https://rpc.testnet.chain.robinhood.com");
  });

  describe("fallback transport", () => {
    let primary: Server;
    let backup: Server;
    let primaryHits = 0;
    const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
    let urls: string[] = [];
    beforeAll(async () => {
      primary = createServer((_req, res) => {
        primaryHits++;
        res.writeHead(503).end("down");
      });
      backup = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body) as { id: number } | Array<{ id: number }>;
          const answer = (m: { id: number }) => ({ jsonrpc: "2.0", id: m.id, result: "0xb626" }); // 46630
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(msg) ? msg.map(answer) : answer(msg)));
        });
      });
      urls = [`http://127.0.0.1:${await listen(primary)}`, `http://127.0.0.1:${await listen(backup)}`];
    });
    afterAll(() => {
      primary.close();
      backup.close();
    });

    it("sends the request to the next endpoint when the first fails", async () => {
      const client = createPublicClient({ transport: chainTransport(urls, { timeout: 2_000 }) });
      expect(await client.getChainId()).toBe(46_630);
      expect(primaryHits).toBeGreaterThan(0);
    });
  });
});

describe("the API tells an unreachable chain from a non-vault", () => {
  const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }));
  const app = createApp(ctx);
  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as { error: { code: string; message: string } } };
  };

  it("RPC timeout: 503 RPC_UNAVAILABLE with the testnet sentence, never 'isn't a Glance vault'", async () => {
    vi.spyOn(ctx.client, "readContract").mockRejectedValue(timeout());
    vi.spyOn(ctx.client, "getCode").mockRejectedValue(timeout());
    const { status, body } = await get(`/vault/${VAULT}`);
    expect(status).toBe(503);
    expect(body.error).toEqual({ code: "RPC_UNAVAILABLE", message: RPC_TROUBLE_MESSAGE });
    vi.restoreAllMocks();
  });

  it("the chain answered and there is no contract: NOT_A_VAULT", async () => {
    vi.spyOn(ctx.client, "readContract").mockRejectedValue(zeroData());
    vi.spyOn(ctx.client, "getCode").mockResolvedValue(undefined);
    const { status, body } = await get(`/vault/${VAULT}`);
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_A_VAULT");
    vi.restoreAllMocks();
  });

  it("the chain answered and the contract isn't a vault: NOT_A_VAULT", async () => {
    vi.spyOn(ctx.client, "readContract").mockRejectedValue(zeroData());
    vi.spyOn(ctx.client, "getCode").mockResolvedValue("0x6080");
    const { status, body } = await get(`/vault/${VAULT}`);
    expect(status).toBe(404);
    expect(body.error.message).toBe(`${VAULT} isn't a Glance vault.`);
    vi.restoreAllMocks();
  });

  it("any other endpoint failing on the RPC says so too (not 'something went wrong')", async () => {
    vi.spyOn(ctx.client, "getChainId").mockRejectedValue(http502());
    const { status, body } = await get("/health");
    expect(status).toBe(503);
    expect(body.error.code).toBe("RPC_UNAVAILABLE");
    vi.restoreAllMocks();
  });
});

describe("the process's fetch", () => {
  it("is undici's own once the voice providers load undici, so it matches the global dispatcher undici installs", async () => {
    // Node's built-in fetch on undici 8's dispatcher loses Content-Encoding on the testnet RPC's answers, and viem gets
    // gzip bytes as JSON: every chain read failed. The live suite (test/integration/live.test.ts) covers the real RPC.
    await import("../../src/voice/providers.js");
    const { fetch: undiciFetch } = await import("undici");
    expect(globalThis.fetch).toBe(undiciFetch);
  });
});
