/**
 * The mirroring rule, kept pure so it can be tested on its own.
 *
 * WHY WE COPY updatedAt AND NEVER WRITE "NOW"
 * Our testnet feeds are stand-ins for the real Chainlink feeds on Robinhood Chain mainnet. The honest stand-in is one
 * that behaves exactly like the real feed, so the keeper copies BOTH the price AND the real feed's own updatedAt. A
 * keeper that stamped "now" on every write would make a closed market look open: the vault would see a fresh price at
 * 3am on a Sunday and allow full-size trades. By copying updatedAt, our feeds are fresh while the real market trades,
 * and freeze naturally when it closes, so the vault's weekend guard demonstrates itself on real data rather than a
 * simulation.
 */

export interface Round {
  /** Price, scaled by the feed's decimals. */
  answer: bigint;
  /** Unix seconds of the source's last update. */
  updatedAt: bigint;
}

export type Plan =
  | { action: "write"; round: Round; reason: string }
  | { action: "skip"; reason: string }
  | { action: "hold"; reason: string };

/**
 * Decides what to write to a testnet feed given the source reading, the testnet feed's current reading, and the
 * testnet chain's latest block timestamp.
 *  - write: the source differs from what the testnet feed holds; write the source's answer AND updatedAt, unchanged.
 *  - skip:  the testnet feed already mirrors the source exactly.
 *  - hold:  the source reading cannot be mirrored safely right now; leave the testnet feed as it is.
 */
export function planMirror(source: Round, current: Round, testnetNow: bigint): Plan {
  if (source.answer <= 0n) return { action: "hold", reason: "source price is not positive" };
  if (source.updatedAt === 0n) return { action: "hold", reason: "source has no update time" };
  // TestPriceFeed rejects future timestamps. A few seconds of clock skew between the chains resolves on the next pass;
  // we never clamp to the testnet clock, because that would be writing "now".
  if (source.updatedAt > testnetNow) {
    return { action: "hold", reason: `source updatedAt is ${source.updatedAt - testnetNow}s ahead of the testnet clock` };
  }
  if (source.answer === current.answer && source.updatedAt === current.updatedAt) {
    return { action: "skip", reason: "unchanged" };
  }
  return { action: "write", round: { answer: source.answer, updatedAt: source.updatedAt }, reason: "source changed" };
}
