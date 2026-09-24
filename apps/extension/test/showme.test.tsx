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
import { runShowMe, type ShowMeDeps } from "../lib/showMe";
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
  let endSpeech: () => void = () => {};
  const d: ShowMeDeps & { calls: string[]; progress(t: number, d: number | null): void; end(): void } = {
    calls,
    progress: (t, dur) => progress?.(t, dur),
    end: () => endSpeech(),
    readPage: () => readPage(document, { companies: ["TSLA"] }),
    surface: "page",
    capture: vi.fn(async () => "data:image/jpeg;base64,AAAA"),
    downscale: vi.fn(async () => "BBBB"),
    ask: vi.fn(async () => ({ ok: true as const, data: { reply: reply.spoken, spoken: reply.spoken, actions: reply.actions, source: "claude" as const } })),
    speak: vi.fn(
      (_t, h) =>
        new Promise<void>((resolve) => {
          progress = h.onProgress;
          endSpeech = () => {
            h.onEnd();
            resolve();
          };
          h.onStart();
        }),
    ),
    hush: vi.fn(() => calls.push("hush")),
    findQuote: (q) => findQuote(document.body, q),
    reveal: () => calls.push("reveal"),
    draw: vi.fn((kind) => (calls.push(kind), true)),
    point: vi.fn((r) => calls.push(r ? `point:${r.toString().replace(/\s+/g, " ")}` : "home")),
    chart: vi.fn((s) => calls.push(`chart:${s}`)),
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
