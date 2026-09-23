/** A double click can never send twice. */
import { describe, expect, it } from "vitest";

import { SingleFlight } from "../lib/singleFlight";

describe("SingleFlight", () => {
  it("ignores a second call while the first is in flight, and allows the next one after", async () => {
    const f = new SingleFlight();
    let calls = 0;
    let release!: () => void;
    const slow = () => {
      calls++;
      return new Promise<string>((r) => (release = () => r("sent")));
    };
    const first = f.run(slow);
    expect(f.busy).toBe(true);
    await expect(f.run(slow)).resolves.toBeNull(); // the double click
    expect(calls).toBe(1);
    release();
    await expect(first).resolves.toBe("sent");
    expect(f.busy).toBe(false);
    await f.run(async () => calls++);
    expect(calls).toBe(2);
  });

  it("frees up after a failure", async () => {
    const f = new SingleFlight();
    await expect(f.run(async () => Promise.reject(new Error("rejected")))).rejects.toThrow("rejected");
    await expect(f.run(async () => "again")).resolves.toBe("again");
  });
});
