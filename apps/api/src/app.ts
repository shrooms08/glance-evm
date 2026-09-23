/**
 * HTTP routes. Every input is validated with zod; every error leaves as { error: { code, message, guard? } }.
 */
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { isAddress } from "viem";
import { z } from "zod";

import type { AppContext } from "./context.js";
import { rateLimit } from "./rateLimit.js";
import { ApiError, activityView, healthView, priceView, quoteView, tradeView, vaultView } from "./services.js";
import { registerVoice } from "./voice/routes.js";

const MAX_RESOLVE_CHARS = 20_000;

const address = z.string().refine((v) => isAddress(v, { strict: false }), "must be a 0x address");
const symbol = z.string().trim().regex(/^[A-Za-z]{1,6}$/, "must be a ticker like TSLA");
const decimal = z.string().trim().regex(/^\d+(\.\d+)?$/, "must be a positive decimal number like 25 or 0.5");
const side = z.enum(["buy", "sell"]);
const slippageBps = z.coerce.number().int().min(0).max(1_000);

const resolveBody = z.object({ text: z.string().min(1).max(MAX_RESOLVE_CHARS) });
const quoteQuery = z.object({ vault: address, symbol, side, amount: decimal, slippageBps: slippageBps.optional() });
const tradeBody = z.object({ vault: address, symbol, side, amount: decimal, slippageBps: slippageBps.optional() }).strict();
const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const priceQuery = z.object({ vault: address.optional() });

/** JSON with bigints as decimal strings. */
function send(c: Context, body: unknown, status: 200 | 400 | 404 | 409 | 422 | 429 | 500 | 502 | 503 = 200) {
  return c.body(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), status, {
    "content-type": "application/json; charset=utf-8",
  });
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new ApiError(400, "INVALID_INPUT", detail);
  }
  return r.data;
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must be JSON.");
  }
}

export function createApp(ctx: AppContext) {
  return createServerApp(ctx).app;
}

/** The app plus the WebSocket hook the Node server needs for /voice/stream. */
export function createServerApp(ctx: AppContext) {
  const app = new Hono();
  const { config } = ctx;
  const nodeWs = createNodeWebSocket({ app });

  if (config.NODE_ENV !== "test") app.use(logger()); // method, path, status and time only: no bodies, no keys

  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return null;
        if (config.corsOrigins.includes(origin)) return origin;
        if (config.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
        return null;
      },
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      exposeHeaders: ["x-voice-cache", "x-voice-ms"],
      maxAge: 600,
    }),
  );
  app.use("*", rateLimit({ limit: config.RATE_LIMIT_PER_MINUTE, trustProxy: config.TRUST_PROXY, name: "all" }));
  app.use("/trade", rateLimit({ limit: config.TRADE_RATE_LIMIT_PER_MINUTE, trustProxy: config.TRUST_PROXY, name: "trade" }));

  app.get("/health", async (c) => send(c, await healthView(ctx)));

  app.get("/catalog", (c) =>
    send(c, {
      chainId: ctx.deployment.chainId,
      usdg: ctx.deployment.usdg,
      stocks: ctx.catalog.entries,
    }),
  );

  app.post("/resolve", async (c) => {
    const { text } = parse(resolveBody, await jsonBody(c));
    let matches = ctx.resolver.resolve(text);
    let source: "dictionary" | "llm" | "none" = matches.length ? "dictionary" : "none";
    if (matches.length === 0 && ctx.llm) {
      try {
        matches = await ctx.llm.resolve(text);
        if (matches.length) source = "llm";
      } catch {
        // The fallback is optional: a failed or slow LLM call means "no matches", never an error.
      }
    }
    const withEntries = matches.map((m) => ({ ...m, stock: ctx.catalog.bySymbol.get(m.symbol) }));
    return send(c, { source, count: withEntries.length, matches: withEntries });
  });

  app.get("/price/:symbol", async (c) => {
    const { vault } = parse(priceQuery, c.req.query());
    return send(c, await priceView(ctx, parse(symbol, c.req.param("symbol")), vault));
  });

  app.get("/vault/:address", async (c) => send(c, await vaultView(ctx, parse(address, c.req.param("address")))));

  app.get("/vault/:address/activity", async (c) => {
    const { limit } = parse(activityQuery, c.req.query());
    return send(c, await activityView(ctx, parse(address, c.req.param("address")), limit));
  });

  app.get("/quote", async (c) => {
    const q = parse(quoteQuery, c.req.query());
    const { _call, ...quote } = await quoteView(ctx, q);
    return send(c, quote);
  });

  app.post("/trade", async (c) => {
    const body = parse(tradeBody, await jsonBody(c));
    return send(c, await tradeView(ctx, body));
  });

  registerVoice(app, ctx, send, parse, jsonBody, nodeWs.upgradeWebSocket);

  app.notFound((c) => send(c, { error: { code: "NOT_FOUND", message: "No such endpoint." } }, 404));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return send(c, { error: { code: err.code, message: err.message, guard: err.guard } }, err.status);
    }
    // Unexpected errors: log the class and message only (never request bodies or keys).
    console.error(`[api] ${err.name}: ${err.message.split("\n")[0]}`);
    return send(c, { error: { code: "INTERNAL", message: "Something went wrong reading the chain. Try again." } }, 502);
  });

  return { app, injectWebSocket: nodeWs.injectWebSocket };
}
