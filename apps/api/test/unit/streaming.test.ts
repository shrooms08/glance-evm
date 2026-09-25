/**
 * Speaking on the first sentence: the sentence splitter, Show me streamed (the first sentence goes out before Claude
 * has finished, each sentence carries its own tags, tags are never in the spoken text, a sentence that trips the guard
 * ends the answer), and the pinned voice for later sentences (only that voice, or a 503). Fakes only: no network.
 */
import { resolve } from "node:path";

import { LINES } from "@glance/core/persona";
import { SentenceSplitter, splitSentences } from "@glance/core/sentences";
import { isSlowRequest } from "@glance/core/showme";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import type { MessagesClient } from "../../src/llm.js";
import { HAIKU, LlmBudget } from "../../src/llmBudget.js";
import { createShowMe, type ShowMeEvent } from "../../src/showme.js";
import { selectVoiceProviders } from "../../src/voice/providers.js";
import { FAKE_PROVIDER_KEY } from "../support/fake-keys.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const baseEnv = { NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" };
const ctx = createContext(loadConfig(baseEnv), () => {});
const KEY = FAKE_PROVIDER_KEY;

describe("sentence splitter", () => {
  it("splits at end punctuation as the text arrives", () => {
    const s = new SentenceSplitter();
    expect(s.push("Tesla rose four percent")).toEqual([]);
    expect(s.push(" on Tuesday. Revenue ")).toEqual(["Tesla rose four percent on Tuesday."]);
    expect(s.push("grew! Why? ")).toEqual(["Revenue grew!", "Why?"]);
    expect(s.flush()).toEqual([]);
  });

  it("never splits numbers, abbreviations, initials or a tag", () => {
    expect(splitSentences("It's at $3.50 today. The U.S. market is open. Tesla Inc. said so. J. Smith agreed.")).toEqual([
      "It's at $3.50 today.",
      "The U.S. market is open.",
      "Tesla Inc. said so.",
      "J. Smith agreed.",
    ]);
    expect(splitSentences('Margin was 18.4% [CIRCLE:"reached 18.4%. Revenue"] then. Done.')).toEqual(['Margin was 18.4% [CIRCLE:"reached 18.4%. Revenue"] then.', "Done."]);
    // A number split across chunks ("$3" then ".50") isn't cut early.
    const s = new SentenceSplitter();
    expect(s.push("It's $3.")).toEqual([]);
    expect(s.push("50 now. Next.")).toEqual(["It's $3.50 now."]);
    expect(s.flush()).toEqual(["Next."]);
  });

  it("cuts a long sentence with no end at its last comma, past about 120 characters", () => {
    const long = "Tesla makes electric cars and batteries and solar panels, and it also runs a charging network across many countries, and it keeps growing";
    const s = new SentenceSplitter();
    const out = s.push(long);
    expect(out).toHaveLength(1);
    expect(out[0]!.endsWith(",")).toBe(true);
    expect(out[0]!.length).toBeLessThanOrEqual(130);
  });
});

/** A fake streaming Anthropic client: yields text deltas, and waits for `release()` before the last ones. */
function streaming(chunks: string[], holdAfter = 1) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const create = vi.fn(async (params: { stream?: boolean }) => {
    expect(params.stream).toBe(true);
    return (async function* () {
      yield { type: "message_start", message: { usage: { input_tokens: 1_800, output_tokens: 1 } } };
      for (const [i, text] of chunks.entries()) {
        if (i === holdAfter) await gate;
        yield { type: "content_block_delta", delta: { type: "text_delta", text } };
      }
      yield { type: "message_delta", usage: { output_tokens: 70 } };
    })();
  });
  return { client: { messages: { create } } as unknown as MessagesClient, create, release };
}

const page = { title: "Tesla | News", host: "news.example", text: "Revenue grew 12% to $25.2 billion. The gross margin reached 18.4%.", companies: ["TSLA"] };

function show(client: MessagesClient, other = 70) {
  const budget = new LlmBudget({ total: 250, perPurpose: { resolver: 40, intent: 80, why: 60, other } }, null, () => {}, () => Date.parse("2026-09-24T12:00:00Z"));
  return createShowMe({ model: HAIKU, budget, symbols: ["TSLA", "AMD"], client, log: () => {} })!;
}

describe("Show me, streamed", () => {
  it("the first sentence goes out before Claude has finished; each sentence carries its own tags; tags are never spoken", async () => {
    const f = streaming(['Revenue grew twelve percent [CIRCLE:"Revenue grew 12%"]. ', 'The margin was eighteen point four [CIRCLE:"18.4%"]', " percent."]);
    const events: ShowMeEvent[] = [];
    const done = show(f.client).answerStream({ question: "show me the key numbers", page }, (e) => events.push(e));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    // Claude is still writing (held), and the first sentence is already out.
    expect(events[0]).toMatchObject({ type: "sentence", sentence: { i: 0, spoken: "Revenue grew twelve percent.", actions: [{ kind: "CIRCLE", quote: "Revenue grew 12%", at: 27 }] } });
    f.release();
    await done;
    expect(events.map((e) => e.type)).toEqual(["sentence", "sentence", "done"]);
    const second = events[1] as Extract<ShowMeEvent, { type: "sentence" }>;
    expect(second.sentence).toMatchObject({ i: 1, spoken: "The margin was eighteen point four percent.", actions: [{ kind: "CIRCLE", quote: "18.4%" }] });
    for (const e of events) if (e.type === "sentence") expect(e.sentence.spoken).not.toMatch(/\[|\]/);
  });

  it("a sentence that advises ends the answer with the safe line", async () => {
    const f = streaming(["Tesla rose today. ", "You should buy it now. ", "It will rise."], 99);
    const events: ShowMeEvent[] = [];
    await show(f.client).answerStream({ question: "should I buy Tesla?", page }, (e) => events.push(e));
    expect(events.filter((e) => e.type === "sentence").map((e) => (e as Extract<ShowMeEvent, { type: "sentence" }>).sentence.spoken)).toEqual(["Tesla rose today.", LINES.noAdvice]);
    expect(events.at(-1)).toEqual({ type: "done", source: "guarded" });
  });

  it("out of budget: the plain line, no call", async () => {
    const f = streaming(["Hi."]);
    const events: ShowMeEvent[] = [];
    await show(f.client, 0).answerStream({ question: "explain this", page }, (e) => events.push(e));
    expect(f.create).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: "sentence", sentence: { i: 0, spoken: LINES.outOfThinking, actions: [] } },
      { type: "done", source: "budget" },
    ]);
  });

  it("POST /showme/stream sends Server-Sent Events", async () => {
    const f = streaming(["One. ", "Two."], 99);
    const app = createApp({ ...ctx, showMe: show(f.client) });
    const res = await app.request("/showme/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "what's this about?", page }) });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const body = await res.text();
    expect(body).toContain("event: sentence");
    expect(body).toContain('"spoken":"One."');
    expect(body).toContain("event: done");
  });

  it("which requests get the spoken acknowledgment: the slow ones only", () => {
    for (const q of ["show me the key numbers in this article", "what's a stock token?", "how do I withdraw?", "why did Tesla drop?", "explain this chart"]) expect(isSlowRequest(q)).toBe(true);
    for (const q of ["what's Tesla at?", "how am I doing?", "buy ten dollars of Tesla", "cancel", "yes"]) expect(isSlowRequest(q)).toBe(false);
  });
});

describe("the rest of a reply, in the first sentence's voice", () => {
  function providers(plan: { flux: Array<"ok" | number> }) {
    let n = 0;
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL) => {
      const which = String(url).includes("/v2/speak") ? "flux" : "aura";
      calls.push(which);
      const a = which === "flux" ? (plan.flux[n++] ?? "ok") : "ok";
      if (a !== "ok") return new Response("no", { status: a });
      return new Response(new Uint8Array([which.length]), { headers: { "content-type": "audio/mpeg" } });
    });
    const v = selectVoiceProviders(loadConfig({ ...baseEnv, DEEPGRAM_API_KEY: KEY }), { fetch: fetchFn as unknown as typeof fetch, log: () => {} });
    return { v, calls };
  }

  it("?voice= tries only that voice (and its retry): if it fails, 503, never another voice", async () => {
    const { v, calls } = providers({ flux: [429, 429] });
    const c2 = createContext(loadConfig({ ...baseEnv, DEEPGRAM_API_KEY: KEY }), () => {});
    c2.voice = v;
    c2.prerecorded = null;
    const app = createApp(c2);
    const res = await app.request(`/voice/speak?text=${encodeURIComponent("The next sentence.")}&voice=flux-sienna-en`);
    expect(res.status).toBe(503);
    expect(calls).toEqual(["flux", "flux"]); // no Harmonia
  });

  it("the first sentence's answer says which voice spoke it", async () => {
    const { v } = providers({ flux: ["ok"] });
    const c2 = createContext(loadConfig({ ...baseEnv, DEEPGRAM_API_KEY: KEY }), () => {});
    c2.voice = v;
    c2.prerecorded = null;
    const res = await createApp(c2).request(`/voice/speak?text=${encodeURIComponent("The first sentence.")}`);
    expect(res.headers.get("x-voice")).toBe("flux-sienna-en");
    const pinned = await createApp(c2).request(`/voice/speak?text=${encodeURIComponent("The second.")}&voice=flux-sienna-en`);
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get("x-voice")).toBe("flux-sienna-en");
  });
});
