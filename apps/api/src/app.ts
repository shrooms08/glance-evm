/**
 * HTTP routes. Every input is validated with zod; every error leaves as { error: { code, message, guard? } }.
 */
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type Context } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";

import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { formatEther, getAddress, isAddress } from "viem";
import { ALL_RANGES } from "@glance/core/chart";
import { LINES } from "@glance/core/persona";

import type { GuardError } from "./errors.js";
import { z } from "zod";

import type { AppContext } from "./context.js";
import { clientIp, rateLimit, sessionOf } from "./rateLimit.js";
import { isRpcTrouble } from "./rpc.js";
import { attemptLabel } from "./refusals.js";
import { activityView, ApiError, chartView, healthView, liveView, portfolioView, priceView, quoteView, type RefusedAttempt, rpcUnavailable, SELL_FRACTIONS, tradeView, vaultView, whyView } from "./services.js";
import { registerVoice } from "./voice/routes.js";
import { factsView } from "./chartFacts.js";
import { VISION_MAX_IMAGE_CHARS } from "./chartVision.js";
import { chartContextFor } from "./showmeChart.js";
import { compareAnyView } from "./compareAny.js";
import type { ShowMeEvent } from "./showme.js";
import { streamSSE } from "hono/streaming";
import { SESSION_HEADERS } from "@glance/core/session";
import { linkBody, revokeBody } from "./sessions.js";
import { STARTER_USDG } from "./faucet.js";
import { agentExecutor, BasketJobs, basketPreflight, executeLegs } from "./basket.js";

/** Largest JSON body accepted (Show me's page context included). */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

const MAX_RESOLVE_CHARS = 20_000;

const address = z.string().refine((v) => isAddress(v, { strict: false }), "must be a 0x address");
const symbol = z.string().trim().regex(/^[A-Za-z]{1,6}$/, "must be a ticker like TSLA");
const decimal = z.string().trim().regex(/^\d+(\.\d+)?$/, "must be a positive decimal number like 25 or 0.5");
const side = z.enum(["buy", "sell"]);
const slippageBps = z.coerce.number().int().min(0).max(1_000);

const resolveBody = z.object({ text: z.string().min(1).max(MAX_RESOLVE_CHARS) });
/** A glance's unresolved candidate names: the server keeps the first MAX_NAMES company-like ones. */
const namesBody = z.object({ names: z.array(z.string().max(120)).max(200) });
/**
 * A quote names its amount one way: `amount` (USDG for a buy, shares for a sell), or, for a sell only, `usd` (dollars
 * worth at the vault's price) or `fraction` ("1" all, "0.5" half of the holding). /trade always takes shares.
 */
const quoteQuery = z
  .object({
    vault: address,
    symbol,
    side,
    amount: decimal.optional(),
    usd: decimal.optional(),
    fraction: z.enum(SELL_FRACTIONS).optional(),
    slippageBps: slippageBps.optional(),
  })
  .refine((q) => [q.amount, q.usd, q.fraction].filter((x) => x !== undefined).length === 1, "name exactly one of amount, usd or fraction")
  .refine((q) => q.side === "sell" || (q.usd === undefined && q.fraction === undefined), "usd and fraction are for sells only");
const tradeBody = z.object({ vault: address, symbol, side, amount: decimal, slippageBps: slippageBps.optional() }).strict();
/** A basket: the legs in order, each an amount in dollars (the extension planned them from the weights). */
const basketBody = z
  .object({ vault: address, legs: z.array(z.object({ symbol, amount: decimal }).strict()).min(1).max(10), slippageBps: slippageBps.optional() })
  .strict();
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
        figures: z
          .array(
            z.object({
              n: z.number().int().min(1).max(50),
              kind: z.string().max(16),
              alt: z.string().max(300).optional(),
              caption: z.string().max(400).optional(),
              heading: z.string().max(300).optional(),
              width: z.number().min(0).max(20_000),
              height: z.number().min(0).max(20_000),
            }),
          )
          .max(20)
          .optional(),
      })
      .optional(),
    openChart: z.object({ symbol, range: z.enum(ALL_RANGES) }).nullable().optional(),
    // A downscaled JPEG, base64: the whole request is 64 KB at most, so the extension keeps this under 36 KB.
    screenshot: z.string().max(MAX_JSON_BODY_BYTES).regex(/^[A-Za-z0-9+/=]+$/).optional(),
    lastGuard: z.object({ code: z.string().max(64), message: z.string().max(400) }).nullable().optional(),
    // A chart on the page, identified by the extension (its stock and range), whose own chart the answer's marks go on
    // ("lens" is kept for older extensions, which laid Glance's chart over it).
    // Any US stock (the page's chart need not be the catalog's), on the page's own range, with how it was calibrated
    // ("dom" labels or "vision"; null on the overlay), why, and whether the overlay was asked for.
    pageChart: z
      .object({
        symbol,
        range: z.enum(ALL_RANGES),
        site: z.enum(["tradingview", "yahoo", "google", "cnbc", "other"]),
        drawOn: z.enum(["page", "lens"]),
        method: z.enum(["canvas", "dom", "vision"]).nullable().optional(),
        reason: z.string().max(200).optional(),
        forced: z.boolean().optional(),
        // The market candles the page's chart matched: the answer's facts come from the same.
        candles: z.object({ fine: z.boolean().optional(), prepost: z.boolean().optional() }).strict().optional(),
      })
      .nullable()
      .optional(),
    // For "since your last buy" (the portfolio event cache; no chain read).
    vault: address.optional(),
    // A question about a chart or image on the page with no screenshot possible: the answer says how to allow one.
    noScreenshot: z.object({ glanceKey: z.string().min(1).max(16) }).nullable().optional(),
  })
  .strict();
const calibrateBody = z
  .object({
    image: z.string().min(100).max(VISION_MAX_IMAGE_CHARS).regex(/^[A-Za-z0-9+/=]+$/),
    width: z.number().int().min(50).max(4_000),
    height: z.number().int().min(50).max(4_000),
  })
  .strict();
const sessionQuery = z.object({ vault: address, session: address });
/**
 * market=1: the market's own candles even for a catalog stock (to fit a page's chart, which draws market prices);
 * fine=1: at a finer step (a page's 1 day chart may draw every minute); prepost=1: with pre- and after-market.
 */
const compareQuery = z.object({ names: z.string().trim().min(1).max(200), range: z.enum(["1D", "1W", "1M"]).default("1W") });
const chartQuery = z.object({ range: z.enum(ALL_RANGES).default("1D"), vault: address.optional(), market: z.enum(["1"]).optional(), fine: z.enum(["1"]).optional(), prepost: z.enum(["1"]).optional() });

/** "GET /voice/speak?text=Hello 200" -> "GET /voice/speak?… 200": query strings never reach the log. */
export function redactQuery(line: string): string {
  return line.replace(/\?\S*/g, "?…");
}

const jsonLimit = bodyLimit({
  maxSize: MAX_JSON_BODY_BYTES,
  onError: (c) => c.json({ error: { code: "TOO_LARGE", message: "That request is too large (64 KB at most)." } }, 413),
});

/** A constant-time comparison of the admin token (never logged: query strings are redacted from the log). */
export function isAdmin(token: string | undefined, given: string | undefined): boolean {
  if (!token || !given) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

const API_VERSION = "0.1.0";

/** /health for everyone in production: ok, chain, block, versions, and the feeds' ages (public, on-chain facts). */
export function publicHealth(h: Awaited<ReturnType<typeof healthView>>, commit?: string) {
  return {
    ok: h.ok,
    chainId: h.chainId,
    expectedChainId: h.expectedChainId,
    blockNumber: h.blockNumber,
    versions: { api: API_VERSION, commit: commit ?? null },
    // The agent Glance trades from (an address, public on chain anyway): the console compares it with each vault's
    // agent to offer "Approve new Glance agent" after a key rotation. Its balance stays in the full view only.
    agent: { address: h.agent?.keyLoaded ? h.agent.address : null, keyLoaded: Boolean(h.agent?.keyLoaded) },
    keeper: { lastWriteAt: h.keeper.lastWriteAt },
    feeds: h.feeds.map((f) => ({
      symbol: f.symbol,
      price: f.price,
      updatedAt: f.updatedAt,
      ageSeconds: f.ageSeconds,
      age: f.age,
      marketState: f.marketState,
      lastWrite: f.lastWrite ? { at: f.lastWrite.at, agoSeconds: f.lastWrite.agoSeconds, txHash: f.lastWrite.txHash } : null,
    })),
  };
}

/** JSON with bigints as decimal strings. */
function send(c: Context, body: unknown, status: 200 | 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503 = 200) {
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
      // Only the extension and the console (CORS_ORIGINS). CORS isn't authentication: trades are signed as well.
      origin: (origin) => (origin && config.corsOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", ...Object.values(SESSION_HEADERS)],
      exposeHeaders: ["x-voice-cache", "x-voice-ms", "x-voice", "x-voice-fallback"],
      maxAge: 600,
    }),
  );
  // JSON bodies are at most 64 KB (Show me's page context included): larger is 413. A recorded command (the voice
  // upload fallback) is audio, with its own cap in the voice routes.
  // Audio uploads and chart crops have their own limits.
  app.use("*", async (c, next) => (c.req.path === "/voice/transcribe" || c.req.path === "/chart/calibrate" ? next() : jsonLimit(c, next)));

  app.use("*", rateLimit({ limit: config.RATE_LIMIT_PER_MINUTE, trustProxy: config.TRUST_PROXY, name: "all" }));
  // "/trade/*" also matches "/trade" itself: one registration covers single trades and baskets. Only sending counts: a
  // basket's progress (GET /trade/basket/:jobId, polled while its legs land) is a read.
  const tradeLimit = rateLimit({ limit: config.TRADE_RATE_LIMIT_PER_MINUTE, trustProxy: config.TRUST_PROXY, name: "trade" });
  app.use("/trade/*", async (c, next) => (c.req.method === "GET" ? next() : tradeLimit(c, next)));
  /**
   * The paid endpoints (Claude, Deepgram) and the heavier reads: a limit per IP, and the same limit per browser session
   * when the request names one (so one browser can't use a whole office's allowance, nor many IPs one browser's).
   */
  const paid: Array<[string[], number, string]> = [
    // "/x/*" also matches "/x" itself: one pattern each, so a request is counted once.
    [["/resolve/*"], config.RESOLVE_RATE_LIMIT_PER_MINUTE, "resolve"],
    [["/why/*"], config.WHY_RATE_LIMIT_PER_MINUTE, "why"],
    // One limit for both Show me routes (the whole answer, and the streamed one).
    [["/showme/*"], config.SHOWME_RATE_LIMIT_PER_MINUTE, "showme"],
    [["/chart/*", "/compare"], config.CHART_RATE_LIMIT_PER_MINUTE, "chart"],
    [["/portfolio/*"], config.PORTFOLIO_RATE_LIMIT_PER_MINUTE, "portfolio"],
    [["/voice/*"], config.VOICE_RATE_LIMIT_PER_MINUTE, "voice"],
  ];
  for (const [paths, limit, name] of paid) {
    const perIp = rateLimit({ limit, trustProxy: config.TRUST_PROXY, name });
    const perSession = rateLimit({ limit, trustProxy: config.TRUST_PROXY, name: `${name}-session`, keyBy: sessionOf });
    for (const path of paths) {
      app.use(path, perIp);
      app.use(path, perSession);
    }
  }
  app.use("/resolve/names", rateLimit({ limit: 20, trustProxy: config.TRUST_PROXY, name: "names" }));

  app.use("/session/*", rateLimit({ limit: config.SESSION_RATE_LIMIT_PER_MINUTE, trustProxy: config.TRUST_PROXY, name: "session" }));
  app.use("/faucet/*", rateLimit({ limit: 10, trustProxy: config.TRUST_PROXY, name: "faucet" }));

  // The starter fund (src/faucet.ts): gas and 20 USDG for a new wallet. Off unless FAUCET_PRIVATE_KEY is set.
  let stock: { at: number; value: Promise<{ gas: boolean; usdg: boolean }> } | null = null;
  app.get("/faucet", async (c) => {
    if (!ctx.faucet) return send(c, { enabled: false, amountEth: null, usdg: { enabled: false, amount: null }, stocked: { gas: false, usdg: false } });
    // Its balances, read at most every 30 seconds.
    if (!stock || Date.now() - stock.at > 30_000) stock = { at: Date.now(), value: ctx.faucet.stock().catch(() => ({ gas: false, usdg: false })) };
    return send(c, { enabled: true, amountEth: formatEther(ctx.faucet.amount), usdg: { enabled: true, amount: STARTER_USDG }, stocked: await stock.value });
  });
  app.post("/faucet/gas", async (c) => {
    if (!ctx.faucet) throw new ApiError(404, "FAUCET_OFF", "Glance's starter fund isn't set up here. Use the Robinhood testnet faucet.");
    const { address: to } = parse(z.object({ address }).strict(), await jsonBody(c));
    return send(c, await ctx.faucet.gas({ address: to, ip: clientIp(c, config.TRUST_PROXY) }));
  });
  app.post("/faucet/usdg", async (c) => {
    if (!ctx.faucet) throw new ApiError(404, "FAUCET_OFF", "Glance's starter fund isn't set up here. Claim from the Paxos faucet.");
    const { address: to } = parse(z.object({ address }).strict(), await jsonBody(c));
    return send(c, await ctx.faucet.usdg({ address: to, ip: clientIp(c, config.TRUST_PROXY) }));
  });

  // In production, the public view only (no agent balance, voice decisions or budgets) unless ?admin=<ADMIN_TOKEN>.
  // Live market prices for display (the console's Prices page, the extension): Finnhub, else Yahoo, each with its
  // source and age. Poll it (every 15s while the market is open is plenty). The vault never trades on these.
  app.get("/quotes/live", (c) => {
    const quotes = ctx.catalog.entries.map((e) => ({ symbol: e.symbol, live: liveView(ctx, e.symbol) }));
    return send(c, { marketOpen: ctx.liveQuotes.marketOpen(), pollMs: ctx.liveQuotes.pollMs(), quotes });
  });

  // Liveness for the host's health check (Railway): answers at once, no chain calls, nothing about the setup.
  app.get("/health/live", (c) => c.json({ ok: true }));

  app.get("/health", async (c) => {
    const full = { ...(await healthView(ctx)), ...(ctx.faucet ? { faucet: await ctx.faucet.status().catch(() => null) } : {}) };
    return send(c, config.NODE_ENV === "production" && !isAdmin(config.ADMIN_TOKEN, c.req.query("admin")) ? publicHealth(full, config.GIT_COMMIT) : full);
  });

  // Browser sessions, linked and unlinked by the vault owner's signature (src/sessions.ts).
  app.post("/session/link", async (c) => {
    const s = await ctx.sessions.link(parse(linkBody, await jsonBody(c)));
    return send(c, { linked: true, vault: s.vault, sessionKey: s.sessionKey, expiresAt: s.expiresAt });
  });
  app.post("/session/revoke", async (c) => send(c, await ctx.sessions.revoke(parse(revokeBody, await jsonBody(c)))));
  app.get("/session/status", (c) => {
    const q = parse(sessionQuery, c.req.query());
    return send(c, ctx.sessions.status(getAddress(q.vault), getAddress(q.session)));
  });
  app.get("/session/list", (c) => {
    const q = parse(z.object({ vault: address }), c.req.query());
    return send(c, { sessions: ctx.sessions.list(getAddress(q.vault)) });
  });

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
    // A question about a stock's move (or with its chart open) gets the chart's summary, to draw on (cached reads only).
    const { charts, facts } = await chartContextFor(ctx, input);
    return send(c, await ctx.showMe.answer({ ...input, charts, facts }));
  });

  // The same, streamed as Server-Sent Events: a "sentence" event the moment each sentence is complete (with its tags),
  // then "done". The extension speaks the first sentence while Claude is still writing the rest.
  app.post("/showme/stream", async (c) => {
    const input = parse(showMeBody, await jsonBody(c));
    return streamSSE(c, async (sse) => {
      // Events go out in order, and the stream stays open until the last one is written.
      let sent = Promise.resolve();
      const emit = (e: ShowMeEvent) => {
        sent = sent.then(() => sse.writeSSE({ event: e.type, data: JSON.stringify(e.type === "sentence" ? e.sentence : { source: e.source }) }));
      };
      if (!ctx.showMe) {
        emit({ type: "sentence", sentence: { i: 0, spoken: LINES.cantThink, actions: [] } });
        emit({ type: "done", source: "unavailable" });
      } else {
        const { charts, facts } = await chartContextFor(ctx, input);
        await ctx.showMe.answerStream({ ...input, charts, facts }, emit);
      }
      await sent;
    });
  });

  // A page chart's geometry read from a screenshot crop (the plot box and axis ticks only; the scale is fitted by the
  // extension, and every number and mark comes from our own facts). Budget "other"; the image is never kept.
  app.post("/chart/calibrate", bodyLimit({ maxSize: VISION_MAX_IMAGE_CHARS + 4_096, onError: (c) => c.json({ error: { code: "TOO_LARGE", message: "That chart image is too large." } }, 413) }), async (c) => {
    const body = parse(calibrateBody, await jsonBody(c));
    if (!ctx.chartVision) throw new ApiError(503, "VISION_UNAVAILABLE", "Reading charts from a screenshot isn't set up on this server.");
    const r = await ctx.chartVision.readLabels({ base64: body.image, width: body.width, height: body.height });
    // Today's vision calls used up (CHART_VISION_DAILY_LIMIT): the extension draws nothing and asks (rule 3).
    if (!r.ok && r.reason === "daily-limit") throw new ApiError(429, "VISION_DAILY_LIMIT", "I've read enough page charts for today.");
    if (!r.ok) throw new ApiError(r.reason === "budget" ? 429 : 503, r.reason === "budget" ? "BUDGET" : "VISION_UNAVAILABLE", r.reason === "budget" ? LINES.outOfThinking : LINES.cantThink);
    return send(c, { labels: r.labels, model: r.model });
  });

  // Any two or three US stocks compared, by name or ticker ("AMD|NVIDIA"): the market's daily candles, every number
  // computed (src/compareAny.ts). Read only: trading stays with the vault's own stocks.
  app.get("/compare", async (c) => {
    const q = parse(compareQuery, c.req.query());
    const names = q.names.split("|").map((n) => n.trim()).filter(Boolean);
    return send(c, await compareAnyView(ctx, names, q.range));
  });

  // The chart's breakdown, computed (src/chartFacts.ts): one stock, or up to three compared ("TSLA,AMD").
  app.get("/chart/:symbols/facts", async (c) => {
    const { range, vault, market, fine, prepost } = parse(chartQuery, c.req.query());
    const symbols = c.req.param("symbols").split(",").map((s) => parse(symbol, s.trim()));
    return send(c, await factsView(ctx, symbols, range, vault ? getAddress(vault) : undefined, { market: market === "1", fine: fine === "1", prepost: prepost === "1" }));
  });

  app.get("/chart/:symbol", async (c) => {
    const { range, vault, market, fine, prepost } = parse(chartQuery, c.req.query());
    return send(c, await chartView(ctx, parse(symbol, c.req.param("symbol")), range, vault ? getAddress(vault) : undefined, { market: market === "1", fine: fine === "1", prepost: prepost === "1" }));
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

  // The only route that makes the agent sign a transaction: a signed request from a browser the vault's owner linked
  // (or an open demo vault), checked before anything else (src/tradeAuth.ts). The on-chain caps still apply.
  app.post("/trade", async (c) => {
    const raw = await c.req.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ApiError(400, "INVALID_JSON", "The request body must be JSON.");
    }
    const body = parse(tradeBody, json);
    await ctx.tradeAuth.check({ raw, fields: { ...body, vault: getAddress(body.vault) }, header: (n) => c.req.header(n), ip: clientIp(c, config.TRUST_PROXY) });
    try {
      return send(c, await tradeView(ctx, body));
    } catch (err) {
      if (err instanceof ApiError && err.guard && err.refused) recordRefusal(ctx, "trade", err.refused, err.guard);
      throw err;
    }
  });

  // ---- Baskets (src/basket.ts): every leg preflighted; one signature; the legs sent one by one ----------------------
  const jobs = new BasketJobs();
  app.post("/quote/basket", async (c) => {
    const body = parse(basketBody, await jsonBody(c));
    const { calls: _calls, ...report } = await basketPreflight(ctx, { ...body, vault: getAddress(body.vault) });
    return send(c, report);
  });
  app.post("/trade/basket", async (c) => {
    const raw = await c.req.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ApiError(400, "INVALID_JSON", "The request body must be JSON.");
    }
    const body = parse(basketBody, json);
    const vault = getAddress(body.vault);
    await ctx.tradeAuth.checkBasket({ raw, fields: { vault, legs: body.legs.map((l) => ({ ...l, side: "buy" as const })), slippageBps: body.slippageBps }, header: (n) => c.req.header(n), ip: clientIp(c, config.TRUST_PROXY) });
    const signer = ctx.signer;
    if (!signer) throw new ApiError(503, "AGENT_KEY_MISSING", "The agent key isn't loaded on this server, so I can't trade.");
    // Checked again now, just before sending: a leg that would be refused is never sent (the extension sends only
    // the legs that passed; if one no longer does, nothing is sent and the report says why).
    const pre = await basketPreflight(ctx, { ...body, vault });
    if (pre.passing !== pre.legs.length) {
      const { calls: _calls, ...report } = pre;
      return c.json({ error: { code: "BASKET_PREFLIGHT", message: "A leg of this basket would be refused now, so nothing was sent.", report } }, 422);
    }
    const job = jobs.create(vault, body.legs);
    // One basket at a time with the agent key (no single trade in between), each leg waiting for the one before.
    void signer
      .exclusive(() => executeLegs(body.legs, agentExecutor(ctx, { ...body, vault }, pre.calls as NonNullable<(typeof pre.calls)[number]>[]), (legs) => (job.legs = legs)))
      .then(
        (r) => {
          job.legs = r.results;
          job.state = r.complete ? "done" : "stopped";
        },
        (err: unknown) => {
          job.state = "failed";
          job.message = isRpcTrouble(err) ? "The testnet stopped responding part way. Check your activity before trying again." : "The basket stopped part way. Check your activity.";
          console.error(`[basket] ${(err as Error).name}: ${String((err as Error).message).split("\n")[0]}`);
        },
      );
    return send(c, { jobId: job.id, legs: job.legs });
  });
  app.get("/trade/basket/:jobId", (c) => {
    const job = jobs.get(c.req.param("jobId"));
    if (!job) throw new ApiError(404, "NOT_FOUND", "No such basket buy (it may have finished over an hour ago).");
    return send(c, { state: job.state, legs: job.legs, message: job.message ?? null });
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
