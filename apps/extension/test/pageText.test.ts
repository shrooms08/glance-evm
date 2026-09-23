import { describe, expect, it } from "vitest";

import { chunks, collectText, rangeFor } from "../lib/pageText";

function page(html: string) {
  document.body.innerHTML = html;
  return collectText(document.body, { isVisible: () => true });
}

describe("page text", () => {
  it("maps API offsets back to the exact DOM text, across inline markup", () => {
    const c = page(`<p>Shares of <a href="#">Tesla</a> rose while <b>Palantir Technologies</b> fell.</p>`);
    expect(c.text).toBe("Shares of Tesla rose while Palantir Technologies fell.");
    const tesla = c.text.indexOf("Tesla");
    expect(rangeFor(document, c.segments, tesla, tesla + 5)!.toString()).toBe("Tesla");
    const pltr = c.text.indexOf("Palantir Technologies");
    expect(rangeFor(document, c.segments, pltr, pltr + 21)!.toString()).toBe("Palantir Technologies");
  });

  it("separates blocks so words in different paragraphs never fuse", () => {
    const c = page(`<p>Tesla</p><p>Motors</p>`);
    expect(c.text).toBe("Tesla\nMotors");
    // An offset that lands on the separator itself has no DOM text behind it.
    expect(rangeFor(document, c.segments, 5, 6)).toBeNull();
    expect(rangeFor(document, c.segments, 6, 12)!.toString()).toBe("Motors");
  });

  it("skips scripts, styles, form fields, code, hidden and our own UI", () => {
    const c = page(`<p>Tesla</p><script>var Tesla=1</script><style>.Tesla{}</style><textarea>Tesla</textarea><code>Tesla</code><div aria-hidden="true">Tesla</div><div id="glance-host">Tesla</div>`);
    const host = document.getElementById("glance-host");
    const c2 = collectText(document.body, { isVisible: () => true, exclude: host });
    expect(c.text.match(/Tesla/g)?.length).toBe(2); // <p> and our host (not excluded in c)
    expect(c2.text).toBe("Tesla");
  });

  it("never touches the page", () => {
    const html = `<p>Buy <a href="#">Tesla</a> now</p>`;
    document.body.innerHTML = html;
    const c = collectText(document.body, { isVisible: () => true });
    rangeFor(document, c.segments, 4, 9);
    expect(document.body.innerHTML).toBe(html);
  });

  it("chunks long text under the API limit on node boundaries", () => {
    const c = page(Array.from({ length: 50 }, (_, i) => `<p>Paragraph ${i} about Tesla and a lot of other words.</p>`).join(""));
    const parts = chunks(c, 200);
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(200);
    expect(parts.map((p) => p.text).join("\n")).toBe(c.text);
  });
});
