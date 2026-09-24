/**
 * HTTP routes. Every input is validated with zod; every error leaves as { error: { code, message, guard? } }.
 */
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { getAddress, isAddress } from "viem";
import { CHART_RANGES } from "@glance/core/chart";
import { LINES } from "@glance/core/persona";

import type { GuardError } from "./errors.js";
import { z } from "zod";

import type { AppContext } from "./context.js";
import { rateLimit } from "./rateLimit.js";
import { isRpcTrouble } from "./rpc.js";
import { attemptLabel } from "./refusals.js";
import { ApiError, activityView, chartView, portfolioView, whyView, type RefusedAttempt, healthView, priceView, quoteView, rpcUnavailable, tradeView, vaultView } from "./services.js";
import { registerVoice } from "./voice/routes.js";

const MAX_RESOLVE_CHARS = 20_000;

const address = z.string().refine((v) => isAddress(v, { strict: false }), "must be a 0x address");
const symbol = z.string().trim().regex(/^[A-Za-z]{1,6}$/, "must be a ticker like TSLA");
const decimal = z.string().trim().regex(/^\d+(\.\d+)?$/, "must be a positive decimal number like 25 or 0.5");
const side = z.enum(["buy", "sell"]);
const slippageBps = z.coerce.number().int().min(0).max(1_000);

const resolveBody = z.object({ text: z.string().min(1).max(MAX_RESOLVE_CHARS) });
/** A glance's unresolved candidate names: the server keeps the first MAX_NAMES company-like ones. */
const namesBody = z.object({ names: z.array(z.string().max(120)).max(200) });
const quoteQuery = z.object({ vault: address, symbol, side, amount: decimal, slippageBps: slippageBps.optional() });
const tradeBody = z.object({ vault: address, symbol, side, amount: decimal, slippageBps: slippageBps.optional() }).strict();
const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const priceQuery = z.object({ vault: address.optional() });
const showMeBody = z
  .object({
    question: z.string().trim().min(1).max(500),
    surface: z.enum(["page", "console"]).default("page"),
    page: z
      .object({
        title: z.string().max(500).optional(),
        host: z.string().max(253).optional(),
        selection: z.string().max(4_000).optional(),
        // Cut to about 6k tokens by the handler; a little slack here for the extension's own cap.
        text: z.string().max(60_000).optional(),
        companies: z.array(z.string().max(8)).max(20).optional(),
      })
      .optional(),
    // A downscaled JPEG, base64 (at most 1280px wide): about 1.5 MB at most.
    screenshot: z.string().max(2_000_000).regex(/^[A-Za-z0-9+/=]+$/).optional(),
    lastGuard: z.object({ code: z.string().max(64), message: z.string().max(400) }).nullable().optional(),
  })
  .strict();
const chartQuery = z.object({ range: z.enum(CHART_RANGES).default("1D"), vault: address.optional() });

/** "GET /voice/speak?text=Hello 200" -> "GET /voice/speak?… 200": query strings never reach the log. */
export function redactQuery(line: string): string {
  return line.replace(/\?\S*/g, "?…");
}

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

  // Method, path, status and time only: no bodies, no keys, and no query strings (GET /voice/speak carries the words
  // being spoken, which can quote the page).
  if (config.NODE_ENV !== "test") app.use(logger((line, ...rest) => console.log(redactQuery(line), ...rest)));

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
      exposeHeaders: ["x-voice-cache", "x-voice-ms", "x-voice"],
      maxAge: 600,
    }),
  );
  app.use("*", rateLimit({ limit: config.RATE_LIMIT_PER_MINUTE, trustProxy: config.TRUST_PROXY, name: "all" }));
  app.use("/trade", rateLimit({ limit: config.TRADE_RATE_LIMIT_PER_MINUTE, trustProxy: config.TRUST_PROXY, name: "trade" }));
  app.use("/resolve/names", rateLimit({ limit: 20, trustProxy: config.TRUST_PROXY, name: "names" }));
  app.use("/why/*", rateLimit({ limit: config.WHY_RATE_LIMIT_PER_MINUTE, trustProxy: config.TRUST_PROXY, name: "why" }));
  app.use("/showme", rateLimit({ limit: config.SHOWME_RATE_LIMIT_PER_MINUTE, trustProxy: config.TRUST_PROXY, name: "showme" }));
  app.use("/chart/*", rateLimit({ limit: config.CHART_RATE_LIMIT_PER_MINUTE, trustProxy: config.TRUST_PROXY, name: "chart" }));
  app.use("/portfolio/*", rateLimit({ limit: config.PORTFOLIO_RATE_LIMIT_PER_MINUTE, trustProxy: config.TRUST_PROXY, name: "portfolio" }));

  app.get("/health", async (c) => send(c, await healthView(ctx)));

  app.get("/catalog", (c) =>
    send(c, {
      chainId: ctx.deployment.chainId,
      usdg: ctx.deployment.usdg,
      stocks: ctx.catalog.entries,
    }),
  );

  // The dictionary only: this runs on every page load and DOM change, so it never calls Claude.
  app.post("/resolve", async (c) => {
    const { text } = parse(resolveBody, await jsonBody(c));
    const matches = ctx.resolver.resolve(text);
    const withEntries = matches.map((m) => ({ ...m, stock: ctx.catalog.bySymbol.get(m.symbol) }));
    return send(c, { source: matches.length ? "dictionary" : "none", count: withEntries.length, matches: withEntries });
  });

  // Once per glance (Option+G, or the panel opening on a page): the page's unresolved candidate names, one Claude call.
  app.post("/resolve/names", async (c) => {
    const { names } = parse(namesBody, await jsonBody(c));
    const answers = ctx.llm ? await ctx.llm.resolveNames(names).catch(() => []) : [];
    const found = answers.filter((a) => a.symbol).map((a) => ({ ...a, stock: ctx.catalog.bySymbol.get(a.symbol!) }));
    return send(c, { asked: answers.length, count: found.length, names: found });
  });

  app.get("/price/:symbol", async (c) => {
    const { vault } = parse(priceQuery, c.req.query());
    return send(c, await priceView(ctx, parse(symbol, c.req.param("symbol")), vault));
  });

  app.get("/vault/:address", async (c) => send(c, await vaultView(ctx, parse(address, c.req.param("address")))));

  app.get("/portfolio/:address", async (c) => send(c, await portfolioView(ctx, parse(address, c.req.param("address")))));

  // Show me, teach and guide: one budgeted Claude call ("other"), nothing from the page kept or logged.
  app.post("/showme", async (c) => {
    const input = parse(showMeBody, await jsonBody(c));
    if (!ctx.showMe) return send(c, { reply: LINES.cantThink, spoken: LINES.cantThink, actions: [], source: "unavailable" });
    return send(c, await ctx.showMe.answer(input));
  });

  app.get("/chart/:symbol", async (c) => {
    const { range, vault } = parse(chartQuery, c.req.query());
    return send(c, await chartView(ctx, parse(symbol, c.req.param("symbol")), range, vault ? getAddress(vault) : undefined));
  });

  app.get("/why/:symbol", async (c) => send(c, await whyView(ctx, parse(symbol, c.req.param("symbol")))));

  app.get("/vault/:address/activity", async (c) => {
    const { limit } = parse(activityQuery, c.req.query());
    return send(c, await activityView(ctx, parse(address, c.req.param("address")), limit));
  });

  app.get("/quote", async (c) => {
    const q = parse(quoteQuery, c.req.query());
    const { _call, ...quote } = await quoteView(ctx, q);
    if (!quote.preflight.ok) recordRefusal(ctx, "quote", quote, quote.preflight.guard);
    return send(c, quote);
  });

  app.post("/trade", async (c) => {
    const body = parse(tradeBody, await jsonBody(c));
    try {
      return send(c, await tradeView(ctx, body));
    } catch (err) {
      if (err instanceof ApiError && err.guard && err.refused) recordRefusal(ctx, "trade", err.refused, err.guard);
      throw err;
    }
  });

  registerVoice(app, ctx, send, parse, jsonBody, nodeWs.upgradeWebSocket);

  app.notFound((c) => send(c, { error: { code: "NOT_FOUND", message: "No such endpoint." } }, 404));

  app.onError((err, c) => {
    // Anything else that failed because the RPC did: say so (the extension retries), not "something went wrong".
    if (!(err instanceof ApiError) && isRpcTrouble(err)) err = rpcUnavailable();
    if (err instanceof ApiError) {
      return send(c, { error: { code: err.code, message: err.message, guard: err.guard } }, err.status);
    }
    // Unexpected errors: log the class and message only (never request bodies or keys).
    console.error(`[api] ${err.name}: ${err.message.split("\n")[0]}`);
    return send(c, { error: { code: "INTERNAL", message: "Something went wrong reading the chain. Try again." } }, 502);
  });

  return { app, injectWebSocket: nodeWs.injectWebSocket };
}

/** A guard stopped a trade before anything was sent: remember it for the console's activity page. */
function recordRefusal(
  ctx: AppContext,
  via: "quote" | "trade",
  q: RefusedAttempt,
  guard: GuardError,
) {
  ctx.refusals.record({
    vault: q.vault,
    attempt: attemptLabel(q.side, q.symbol, q.amountIn.formatted),
    symbol: q.symbol,
    side: q.side,
    amount: q.amountIn.formatted,
    code: guard.code,
    error: guard.error,
    message: guard.message,
    at: q.preflight?.simulatedAt ?? Math.floor(Date.now() / 1000),
    via,
  });
}
