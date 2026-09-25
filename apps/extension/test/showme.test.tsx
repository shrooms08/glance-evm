/**
 * Show me in the extension: finding quotes on the page (exact, whitespace and case variants, not found, off screen),
 * the sync scheduler (in order, at the estimated times, Escape cancels), what's read from the page (never form fields,
 * passwords or payment fields), a screenshot only for a chart question, nothing stored, typed questions, the
 * first-run greeting, and the hand-drawn marks. The API and the voice are faked.
 */
import { circlePath, underlinePath } from "@glance/core/sketch";
import { LINES } from "@glance/core/persona";
import type { ShowAction } from "@glance/core/showme";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { takeGreeting } from "../components/useGreeting";
import { findQuote, revealRange } from "../lib/anchor";
import { parseCommand } from "../lib/commands";
import { readPage, readableText, SHOW_ME_MAX_CHARS, wantsScreenshot } from "../lib/pageRead";
import { CUT_NOTE, fitShowMeBody, runShowMe, SCREENSHOT_MAX_CHARS, SHOW_ME_MAX_BODY_BYTES, type ShowMeDeps } from "../lib/showMe";
import { parseSse, type StreamSentence } from "../lib/showStream";
import type { PartsHandlers } from "../lib/voiceClient";
import { ShowScheduler } from "../lib/showScheduler";

const ARTICLE = `
<header><nav>Home Markets Tech</nav></header>
<article>
  <h1>Tesla deliveries beat estimates</h1>
  <p>Tesla shares rose 4% on Tuesday after the company reported
     record   deliveries for the quarter.</p>
  <p>Revenue grew 12% to $25.2 billion, and the gross margin reached 18.4%.</p>
  <p>Analysts said the <b>Cybertruck</b> ramp is on track.</p>
  <form><label>Email</label><input name="email" value="me@example.com"><input type="password" value="hunter2"></form>
  <div class="checkout"><input autocomplete="cc-number" value="4242424242424242"><span>Card on file</span></div>
</article>
<footer>© Example News</footer>
`;

beforeEach(() => {
  fakeBrowser.reset();
  document.body.innerHTML = ARTICLE;
  document.title = "Tesla deliveries beat | Example News";
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("anchoring quotes", () => {
  it("finds an exact quote", () => {
    const r = findQuote(document.body, "Revenue grew 12%");
    expect(r?.toString()).toBe("Revenue grew 12%");
  });

  it("tolerates whitespace and case, across line breaks and elements", () => {
    expect(findQuote(document.body, "record deliveries")?.toString().replace(/\s+/g, " ")).toBe("record deliveries");
    expect(findQuote(document.body, "REVENUE   GREW 12%")?.toString()).toBe("Revenue grew 12%");
    expect(findQuote(document.body, "the cybertruck ramp")?.toString()).toBe("the Cybertruck ramp");
  });

  it("not on the page: null (the drawing is skipped)", () => {
    expect(findQuote(document.body, "profits collapsed")).toBeNull();
    expect(findQuote(document.body, "")).toBeNull();
  });

  it("scrolls an off-screen quote into view, smoothly; leaves a visible one alone", () => {
    const range = findQuote(document.body, "gross margin")!;
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const at = (top: number) => ({ top, bottom: top + 18, left: 10, right: 90, width: 80, height: 18 }) as DOMRect;
    range.getBoundingClientRect = () => at(2_400);
    expect(revealRange(range)).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    range.getBoundingClientRect = () => at(200);
    expect(revealRange(range)).toBe(false);
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});

describe("the sync scheduler", () => {
  const spoken = "Tesla rose on Tuesday. Revenue grew twelve percent. The margin was eighteen percent, look.";
  const at = (s: string) => spoken.indexOf(s);
  const actions: ShowAction[] = [
    { kind: "UNDERLINE", quote: "gross margin", at: at("The margin") },
    { kind: "POINT", quote: "rose 4%", at: at("rose") },
    { kind: "CIRCLE", quote: "Revenue grew 12%", at: at("Revenue") },
  ];

  it("fires first-sentence tags at the start, the rest in order at their share of the audio", () => {
    const fired: string[] = [];
    const s = new ShowScheduler(actions, spoken, (a) => fired.push(a.kind));
    s.progress(10, 6); // before start: nothing
    expect(fired).toEqual([]);
    s.start();
    expect(fired).toEqual(["POINT"]); // in the first sentence
    const circleAt = (at("Revenue") / spoken.length) * 6;
    s.progress(circleAt - 0.05, 6);
    expect(fired).toEqual(["POINT"]);
    s.progress(circleAt + 0.01, 6);
    expect(fired).toEqual(["POINT", "CIRCLE"]);
    s.progress(5.9, 6);
    expect(fired).toEqual(["POINT", "CIRCLE", "UNDERLINE"]);
    expect(s.done).toBe(true);
  });

  it("estimates from the text while the audio's length is unknown", () => {
    const fired: string[] = [];
    const s = new ShowScheduler(actions, spoken, (a) => fired.push(a.kind));
    s.start();
    s.progress(at("Revenue") / 14 + 0.01, null);
    expect(fired).toEqual(["POINT", "CIRCLE"]);
  });

  it("cancel (Escape) stops everything; finish fires what's left when the voice ends early", () => {
    const fired: string[] = [];
    const s = new ShowScheduler(actions, spoken, (a) => fired.push(a.kind));
    s.start();
    s.cancel();
    s.progress(100, 6);
    s.finish();
    expect(fired).toEqual(["POINT"]);
    const t: string[] = [];
    const u = new ShowScheduler(actions, spoken, (a) => t.push(a.kind));
    u.finish();
    expect(t).toEqual(["POINT", "CIRCLE", "UNDERLINE"]);
  });
});

describe("what's read from the page", () => {
  it("title, host, the main text: never form fields, passwords, card numbers, navigation or footers", () => {
    const p = readPage(document, { companies: ["TSLA"] });
    expect(p.title).toBe("Tesla deliveries beat | Example News");
    expect(p.companies).toEqual(["TSLA"]);
    expect(p.text).toContain("Revenue grew 12% to $25.2 billion");
    for (const secret of ["me@example.com", "hunter2", "4242424242424242", "Email", "Card on file", "Home Markets Tech", "© Example News"]) expect(p.text).not.toContain(secret);
  });

  it("caps the text at about 6,000 tokens", () => {
    document.body.innerHTML = `<article>${"<p>word word word word word word word word.</p>".repeat(3_000)}</article>`;
    expect(readableText(document.body).length).toBeLessThanOrEqual(SHOW_ME_MAX_CHARS);
  });

  it("the selection is sent, unless it's inside a form field", () => {
    const sel = document.getSelection()!;
    const r = document.createRange();
    r.selectNodeContents(document.querySelector("b")!);
    sel.removeAllRanges();
    sel.addRange(r);
    expect(readPage(document).selection).toBe("Cybertruck");
    const r2 = document.createRange();
    r2.selectNodeContents(document.querySelector("label")!);
    sel.removeAllRanges();
    sel.addRange(r2);
    expect(readPage(document).selection).toBeUndefined();
  });

  it("a screenshot only for a question about a chart or an image", () => {
    expect(wantsScreenshot("explain this chart")).toBe(true);
    expect(wantsScreenshot("what's in this picture?")).toBe(true);
    expect(wantsScreenshot("what's this article saying about Tesla?")).toBe(false);
    expect(wantsScreenshot("how do I withdraw?")).toBe(false);
  });
});

function deps(over: Partial<ShowMeDeps> = {}, reply = { spoken: "Deliveries hit a record. Revenue grew too.", actions: [] as ShowAction[] }) {
  const calls: string[] = [];
  let progress: ((t: number, d: number | null) => void) | null = null;
  let endSpeech: (o: "ended" | "cut" | "unavailable") => void = () => {};
  const d: ShowMeDeps & { calls: string[]; progress(t: number, d: number | null): void; end(o?: "ended" | "cut" | "unavailable"): void } = {
    calls,
    progress: (t, dur) => progress?.(t, dur),
    end: (o = "ended") => endSpeech(o),
    readPage: () => readPage(document, { companies: ["TSLA"] }),
    surface: "page",
    capture: vi.fn(async () => "data:image/jpeg;base64,AAAA"),
    downscale: vi.fn(async () => "BBBB"),
    ask: vi.fn(async () => ({ ok: true as const, data: { reply: reply.spoken, spoken: reply.spoken, actions: reply.actions, source: "claude" as const } })),
    speak: vi.fn(
      (_t, h) =>
        new Promise<"ended" | "cut" | "unavailable" | "off">((resolve) => {
          progress = h.onProgress;
          endSpeech = (o) => {
            h.onEnd();
            resolve(o);
          };
          h.onStart();
        }),
    ),
    hush: vi.fn(() => calls.push("hush")),
    findQuote: (q) => findQuote(document.body, q),
    reveal: () => calls.push("reveal"),
    draw: vi.fn((kind) => (calls.push(kind), true)),
    drawArrow: vi.fn(() => (calls.push("ARROW"), true)),
    drawFigure: vi.fn((n) => (calls.push(`figure:${n}`), true)),
    annotate: vi.fn((a) => calls.push(a.kind)),
    point: vi.fn((r) => calls.push(r ? `point:${r.toString().replace(/\s+/g, " ")}` : "home")),
    chart: vi.fn((s, r) => calls.push(`chart:${s}${r ? `:${r}` : ""}`)),
    portfolio: vi.fn(() => calls.push("portfolio")),
    say: vi.fn(),
    done: vi.fn((c) => calls.push(c ? "cleared" : "fade")),
    ...over,
  };
  return d;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Show me, end to end (faked API and voice)", () => {
  it("asks with the page, speaks once, draws in step, skips a quote that isn't there, and fades after", async () => {
    const spoken = "Deliveries hit a record. Revenue grew, see here. And the chart. Not here.";
    const d = deps({}, {
      spoken,
      actions: [
        { kind: "UNDERLINE", quote: "record deliveries", at: spoken.indexOf("hit") },
        { kind: "CIRCLE", quote: "Revenue grew 12%", at: spoken.indexOf("see") },
        { kind: "CHART", symbol: "TSLA", at: spoken.indexOf("chart") },
        { kind: "POINT", quote: "not on this page at all", at: spoken.indexOf("Not") },
      ],
    });
    const run = runShowMe("what's this article saying about Tesla?", d);
    await flush();
    const body = (d.ask as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { question: string; page: { text: string }; screenshot?: string };
    expect(body.question).toBe("what's this article saying about Tesla?");
    expect(body.page.text).toContain("Revenue grew 12%");
    expect(body.screenshot).toBeUndefined();
    expect(d.capture).not.toHaveBeenCalled();
    expect(d.speak).toHaveBeenCalledTimes(1); // one TTS call for the whole reply
    expect(d.calls).toEqual(["reveal", "UNDERLINE", "point:record deliveries"]);
    d.progress(3.5, 6);
    expect(d.calls.slice(3)).toEqual(["reveal", "CIRCLE", "point:Revenue grew 12%"]);
    d.progress(5.99, 6);
    expect(d.calls).toContain("chart:TSLA");
    d.end();
    await run.finished;
    expect(d.calls.slice(-2)).toEqual(["home", "fade"]); // the missing quote was skipped, the talk went on
    expect(d.draw).toHaveBeenCalledTimes(2);
    // Nothing from the page was stored.
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
  });

  it("a chart question takes one downscaled screenshot", async () => {
    const d = deps();
    const run = runShowMe("explain this chart", d);
    await flush();
    expect(d.capture).toHaveBeenCalledTimes(1);
    expect(d.downscale).toHaveBeenCalledWith("data:image/jpeg;base64,AAAA");
    expect(((d.ask as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { screenshot?: string }).screenshot).toBe("BBBB");
    d.end();
    await run.finished;
  });

  it("no screenshot possible (activeTab only comes with the glance key): the request says so, with the key; the vault goes too", async () => {
    const d = deps({ capture: vi.fn(async () => null), vault: () => "0x1111111111111111111111111111111111111111", glanceKey: () => "⌥G" });
    const run = runShowMe("what does this chart show?", d);
    await flush();
    const body = (d.ask as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { screenshot?: string; noScreenshot?: { glanceKey: string }; vault?: string };
    expect(body.screenshot).toBeUndefined();
    expect(body.noScreenshot).toEqual({ glanceKey: "⌥G" });
    expect(body.vault).toBe("0x1111111111111111111111111111111111111111");
    d.end();
    await run.finished;
    // A question that isn't about a picture never carries the flag.
    const d2 = deps({ capture: vi.fn(async () => null) });
    const run2 = runShowMe("how did Tesla do this week?", d2);
    await flush();
    expect(((d2.ask as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { noScreenshot?: unknown }).noScreenshot).toBeUndefined();
    d2.end();
    await run2.finished;
  });

  it("Escape cancels: the voice stops, drawings clear, the orb comes home, and nothing else fires", async () => {
    const spoken = "First. Then later, the margin.";
    const d = deps({}, { spoken, actions: [{ kind: "CIRCLE", quote: "gross margin", at: spoken.indexOf("the margin") }] });
    const run = runShowMe("show me the margin", d);
    await flush();
    run.cancel();
    expect(d.calls).toEqual(["hush", "home", "cleared"]);
    d.progress(100, 2);
    expect(d.draw).not.toHaveBeenCalled();
  });

  it("out of budget: the plain line is spoken, nothing drawn, no error", async () => {
    const d = deps({}, { spoken: LINES.outOfThinking, actions: [] });
    const run = runShowMe("what's a stock token?", d);
    await flush();
    expect((d.speak as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("I'm out of thinking for today, but I can still show prices and charts.");
    d.end();
    await run.finished;
    expect(d.draw).not.toHaveBeenCalled();
  });
});

describe("one voice: a reply that stops part way", () => {
  it("the voice stopped mid-reply: drawings stay where the words got to, the whole answer stays written", async () => {
    const spoken = "Deliveries hit a record. Later on, revenue grew a lot, see here.";
    const d = deps({}, { spoken, actions: [{ kind: "UNDERLINE", quote: "record deliveries", at: spoken.indexOf("hit") }, { kind: "CIRCLE", quote: "Revenue grew 12%", at: spoken.indexOf("see") }] });
    const run = runShowMe("what's this article saying?", d);
    await flush();
    expect(d.calls).toContain("UNDERLINE");
    d.end("cut"); // the audio stalled before "see here"
    await run.finished;
    expect(d.draw).toHaveBeenCalledTimes(1); // the circle never came: its words weren't said
    expect(d.say).toHaveBeenLastCalledWith(spoken, "idle", "The voice stopped there. The rest is written above.");
  });

  it("no voice at all: the answer is written, with a note; drawings still happen", async () => {
    const spoken = "Deliveries hit a record. Revenue grew too, see.";
    const d = deps({}, { spoken, actions: [{ kind: "CIRCLE", quote: "Revenue grew 12%", at: spoken.indexOf("see") }] });
    const run = runShowMe("what's this article saying?", d);
    await flush();
    d.end("unavailable");
    await run.finished;
    expect(d.draw).toHaveBeenCalledTimes(1);
    expect(d.say).toHaveBeenLastCalledWith(spoken, "idle", "No voice right now. The answer is written above.");
  });

  it("nothing in the extension uses the browser's voice (speechSynthesis)", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    for (const dir of ["lib", "components", "entrypoints"]) walk(join(root, dir));
    const offenders = files.filter((f) => /speechSynthesis|SpeechSynthesisUtterance/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("the new tags, end to end", () => {
  it("an arrow with a missing end is skipped; box, highlight and figure are drawn", async () => {
    const spoken = "Look here. And there. And that picture.";
    const d = deps({}, {
      spoken,
      actions: [
        { kind: "ARROW", from: "Revenue grew 12%", to: "not on this page", at: 0 },
        { kind: "ARROW", from: "record deliveries", to: "Revenue grew 12%", at: 0 },
        { kind: "BOX", quote: "gross margin", at: 0 },
        { kind: "HIGHLIGHT", quote: "Cybertruck", at: 0 },
        { kind: "BOX_FIGURE", figure: 1, at: 0 },
      ],
    });
    const run = runShowMe("show me", d);
    await flush();
    expect(d.drawArrow).toHaveBeenCalledTimes(1);
    expect(d.calls.filter((c) => ["ARROW", "BOX", "HIGHLIGHT", "figure:1"].includes(c))).toEqual(["ARROW", "BOX", "HIGHLIGHT", "figure:1"]);
    d.end();
    await run.finished;
  });

  it("chart tags: the chart opens on the reply's range, and each drawing goes to it", async () => {
    const spoken = "Here's the week. It slid here. Down to the low.";
    const d = deps();
    (d.ask as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        reply: spoken,
        spoken,
        source: "claude",
        chart: { symbol: "TSLA", range: "1W" },
        actions: [
          { kind: "CHART", symbol: "TSLA", at: 0 },
          { kind: "CHART_RANGE", symbol: "TSLA", t1: 1, t2: 2, at: spoken.indexOf("It slid") },
          { kind: "CHART_POINT", symbol: "TSLA", t: 2, at: spoken.indexOf("Down") },
          { kind: "CHART_LEVEL", symbol: "TSLA", price: 362.2, label: "Week low $362.20", at: spoken.indexOf("Down") },
        ],
      },
    });
    const run = runShowMe("show me where Tesla dropped this week", d);
    await flush();
    expect(d.calls).toContain("chart:TSLA:1W");
    d.end();
    await run.finished;
    expect(d.calls.filter((c) => c.startsWith("CHART_"))).toEqual(["CHART_RANGE", "CHART_POINT", "CHART_LEVEL"]);
  });
});

describe("Show me, streamed: speaking from the first sentence", () => {
  /** A streamed answer the test writes sentence by sentence, and a parts voice the test plays. */
  function streamedDeps() {
    let onSentence: (s: StreamSentence) => void = () => {};
    let finishAnswer: () => void = () => {};
    let h: PartsHandlers = {};
    let resolveVoice: (o: "ended" | "cut" | "unavailable" | "off") => void = () => {};
    const pushed: string[] = [];
    const d = deps({
      askStream: vi.fn((_body: unknown, cb: (s: StreamSentence) => void) => {
        onSentence = cb;
        return new Promise<{ ok: true; source: string }>((r) => (finishAnswer = () => r({ ok: true, source: "claude" })));
      }),
      speakParts: vi.fn((handlers) => {
        h = handlers;
        return {
          push: (text: string) => (text ? pushed.push(text) - 1 : null),
          end: () => {},
          result: new Promise<"ended" | "cut" | "unavailable" | "off">((r) => (resolveVoice = r)),
        };
      }),
    });
    return { d, pushed, sentence: (s: StreamSentence) => onSentence(s), answerDone: () => finishAnswer(), voice: () => h, voiceDone: (o: "ended" | "cut" | "unavailable" | "off") => resolveVoice(o) };
  }

  it("each sentence is spoken as it arrives; its tags fire with its own audio; no tag is ever spoken", async () => {
    const t = streamedDeps();
    const run = runShowMe("show me the key numbers", t.d);
    await flush();
    expect(t.d.ask).not.toHaveBeenCalled();
    const first = "Revenue grew twelve percent, right here.";
    t.sentence({ i: 0, spoken: first, actions: [{ kind: "CIRCLE", quote: "Revenue grew 12%", at: first.indexOf("right") }] });
    // Spoken straight away, while the rest is still being written.
    expect(t.pushed).toEqual([first]);
    expect(t.d.calls).toEqual([]); // nothing fires before its audio starts
    t.voice().onPart!(0);
    t.voice().onProgress!(0, 1.5, 2.5);
    expect(t.d.calls).toEqual(["reveal", "CIRCLE", "point:Revenue grew 12%"]);
    const second = "And the margin.";
    t.sentence({ i: 1, spoken: second, actions: [{ kind: "UNDERLINE", quote: "gross margin", at: 0 }] });
    expect(t.d.calls).not.toContain("UNDERLINE"); // part 1 hasn't started playing
    t.voice().onPartEnd!(0);
    t.voice().onPart!(1);
    expect(t.d.calls).toContain("UNDERLINE");
    for (const text of t.pushed) expect(text).not.toMatch(/\[|\]/);
    t.answerDone();
    t.voice().onPartEnd!(1);
    t.voiceDone("ended");
    await run.finished;
    expect(t.d.say).toHaveBeenLastCalledWith(`${first} ${second}`, "idle", undefined);
    expect(t.d.calls.slice(-2)).toEqual(["home", "fade"]);
  });

  it("a later sentence that can't be said stops the reply there: its drawings never come, the rest stays written", async () => {
    const t = streamedDeps();
    const run = runShowMe("show me the key numbers", t.d);
    await flush();
    t.sentence({ i: 0, spoken: "Deliveries hit a record.", actions: [{ kind: "UNDERLINE", quote: "record deliveries", at: 0 }] });
    t.voice().onPart!(0);
    t.sentence({ i: 1, spoken: "Revenue grew.", actions: [{ kind: "CIRCLE", quote: "Revenue grew 12%", at: 0 }] });
    t.answerDone();
    t.voice().onPartEnd!(0);
    t.voice().onCut!(1);
    t.voiceDone("cut");
    await run.finished;
    expect(t.d.draw).toHaveBeenCalledTimes(1);
    expect(t.d.calls).not.toContain("CIRCLE");
    expect(t.d.say).toHaveBeenLastCalledWith("Deliveries hit a record. Revenue grew.", "idle", CUT_NOTE);
  });

  it("server-sent events survive being split anywhere", () => {
    const wire = 'event: sentence\ndata: {"i":0,"spoken":"One.","actions":[]}\n\nevent: done\ndata: {"source":"claude"}\n\n';
    const events: string[] = [];
    let rest = "";
    for (const ch of wire.match(/[\s\S]{1,7}/g)!) {
      const out = parseSse(rest + ch);
      rest = out.rest;
      events.push(...out.events.map((e) => `${e.event}:${e.data}`));
    }
    expect(events).toEqual(['sentence:{"i":0,"spoken":"One.","actions":[]}', 'done:{"source":"claude"}']);
  });
});

describe("typed questions go to Show me", () => {
  const companies = [{ symbol: "TSLA", aliases: ["Tesla"] }];
  it.each(["what's this article saying about Tesla?", "explain this chart", "what's a stock token?", "how do I change my limits?", "walk me through Glance", "should I buy Tesla?"])(
    "%s -> ask",
    (q) => expect(parseCommand(q, companies)).toEqual({ kind: "ask", question: q }),
  );
  it("trades and prices still parse as before", () => {
    expect(parseCommand("buy $10 of Tesla", companies)).toEqual({ kind: "buy", symbol: "TSLA", amount: "10" });
    expect(parseCommand("what's Tesla at", companies)).toEqual({ kind: "price", symbol: "TSLA" });
  });
});

describe("personality touches", () => {
  it("the greeting shows once, ever (stored locally)", async () => {
    const first = await takeGreeting("⌥G", "⌥V");
    expect(first).toBe("Hi, I'm Glance. I read the page with you, show prices and charts, and explain what you're looking at. Tap ⌥G to glance, hold ⌥V to talk.");
    expect(await takeGreeting("⌥G", "⌥V")).toBeNull();
  });

  it("hand-drawn marks are deterministic per target", () => {
    const box = { x: 10, y: 20, width: 120, height: 18 };
    expect(circlePath(box, 7)).toBe(circlePath(box, 7));
    expect(circlePath(box, 7)).not.toBe(circlePath(box, 8));
    expect(underlinePath(box, 3)).toMatch(/^M7\.0,/);
  });
});

describe("Show me requests fit the API's 64 KB limit", () => {
  const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;

  it("a long page is shortened from the end (its opening kept); a small one is untouched", () => {
    const text = `Opening line. ${"é".repeat(40_000)}`; // two bytes each: 80 KB of text
    const body = fitShowMeBody({ question: "what's this?", surface: "page", page: { title: "t", host: "h", text, companies: [] } });
    expect(size(body)).toBeLessThanOrEqual(SHOW_ME_MAX_BODY_BYTES);
    expect(body.page!.text.startsWith("Opening line.")).toBe(true);
    const small = { question: "hi", surface: "page" as const, page: { title: "t", host: "h", text: "short", companies: [] } };
    expect(fitShowMeBody(small)).toEqual(small);
  });

  it("a screenshot too big for the request is left out; one that fits stays", () => {
    const page = { title: "t", host: "h", text: "chart page", companies: [] };
    expect(fitShowMeBody({ question: "explain this chart", surface: "page", page, screenshot: "A".repeat(SCREENSHOT_MAX_CHARS + 1) }).screenshot).toBeUndefined();
    expect(fitShowMeBody({ question: "explain this chart", surface: "page", page, screenshot: "A".repeat(20_000) }).screenshot).toHaveLength(20_000);
  });
});
