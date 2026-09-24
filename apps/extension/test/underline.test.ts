/**
 * Claude is asked about a page's company names only when the user glances, in one request per glance, and never on a
 * passive page load or DOM change. The API is faked: nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolve = vi.fn();
const resolveNames = vi.fn();
vi.mock("../lib/api", () => ({ api: { resolve: (t: string) => resolve(t), resolveNames: (n: string[]) => resolveNames(n) } }));

import { companyCandidates, MAX_CANDIDATES, occurrences } from "../lib/candidates";
import { Underliner } from "../lib/underline";

const ARTICLE = `
<p>Shares of Tesla rose on Monday after Palantir Technologies won a contract.</p>
<p>Analysts at Bank of America said Palantir Technologies and Acme Widgets would benefit. The Initech deal closed.</p>
`;

/** A dictionary that knows "Tesla" only. */
function dictionary(text: string) {
  const matches = [...text.matchAll(/Tesla/g)].map((m) => ({ symbol: "TSLA", text: "Tesla", start: m.index!, end: m.index! + 5, kind: "name", source: "dictionary" }));
  return { ok: true, data: { source: matches.length ? "dictionary" : "none", matches } };
}

describe("company lookup triggers", () => {
  let host: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    resolve.mockReset().mockImplementation(async (t: string) => dictionary(t));
    resolveNames.mockReset().mockImplementation(async (names: string[]) => ({
      ok: true,
      data: { asked: names.length, count: 1, names: names.includes("Palantir Technologies") ? [{ name: "Palantir Technologies", symbol: "PLTR", source: "llm" }] : [] },
    }));
    document.body.innerHTML = ARTICLE;
    host = document.createElement("div");
    document.body.append(host);
  });
  afterEach(() => vi.useRealTimers());

  it("a passive page load and DOM changes use the dictionary only: no names request", async () => {
    const u = new Underliner(host);
    u.start();
    await vi.runAllTimersAsync();
    document.body.insertAdjacentHTML("afterbegin", "<p>Breaking: Globex Corporation beats estimates.</p>");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(resolve).toHaveBeenCalled();
    expect(resolveNames).not.toHaveBeenCalled();
    expect(u.current().map((m) => m.symbol)).toEqual(["TSLA"]);
    u.stop();
  });

  it("a glance makes exactly one names request, with every unresolved candidate, and underlines what it confirms", async () => {
    const u = new Underliner(host);
    await u.glance();
    expect(resolveNames).toHaveBeenCalledTimes(1);
    const sent = resolveNames.mock.calls[0]![0] as string[];
    expect(sent[0]).toBe("Palantir Technologies"); // most frequent first
    expect(sent).toEqual(expect.arrayContaining(["Bank of America", "Acme Widgets", "Initech"]));
    expect(sent).not.toContain("Tesla"); // the dictionary already knew it
    expect(sent).not.toContain("Monday");
    expect(sent).not.toContain("Shares");
    expect(u.current().map((m) => m.symbol).sort()).toEqual(["PLTR", "PLTR", "TSLA"]);
  });

  it("a second glance on the same page asks only about new names (none: no request)", async () => {
    const u = new Underliner(host);
    await u.glance();
    await u.glance();
    expect(resolveNames).toHaveBeenCalledTimes(1);
    document.body.insertAdjacentHTML("beforeend", "<p>Later, Globex Corporation joined the deal.</p>");
    await u.glance();
    expect(resolveNames).toHaveBeenCalledTimes(2);
    expect(resolveNames.mock.calls[1]![0]).toEqual(["Globex Corporation"]);
    // Confirmed names stay underlined by later passive scans, with no request.
    await u.scan();
    expect(resolveNames).toHaveBeenCalledTimes(2);
    expect(u.current().filter((m) => m.symbol === "PLTR")).toHaveLength(2);
  });
});

describe("candidate names", () => {
  it("picks proper nouns, skips common words, dates, sentence-initial words and dictionary matches", () => {
    const text = "Shares of Tesla fell. The EV maker told Reuters on Monday that AT&T and Bank of America were partners. Rivian too.";
    const tesla = { start: text.indexOf("Tesla"), end: text.indexOf("Tesla") + 5 };
    expect(companyCandidates(text, [tesla])).toEqual(["AT&T", "Bank of America"]);
  });

  it("deduplicates, orders by frequency, skips names already asked, and caps at 40", () => {
    const text = "We met Initech. Then Globex and Initech. Also Initech and Globex and Umbrella Corp.";
    expect(companyCandidates(text)).toEqual(["Initech", "Globex", "Umbrella Corp"]);
    expect(companyCandidates(text, [], new Set(["initech"]))).toEqual(["Globex", "Umbrella Corp"]);
    const many = Array.from({ length: 60 }, (_, i) => `and Company${i} Holdings`).join(", ");
    expect(companyCandidates(many)).toHaveLength(MAX_CANDIDATES);
  });

  it("finds whole-word occurrences only", () => {
    expect(occurrences("Globex, Globexx and Globex.", "Globex")).toEqual([{ start: 0, end: 6 }, { start: 20, end: 26 }]);
  });
});
