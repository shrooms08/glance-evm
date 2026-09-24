/**
 * How the Prices page names each stock's price source, said plainly. The same wording is in docs/CHAIN_NOTES.md.
 *   mirrored     "Chainlink, mirrored from mainnet": the live Robinhood Chain mainnet Chainlink feed, price and timestamp
 *   public quote "Public quote (no Chainlink NFLX feed on Robinhood Chain)": NFLX has no Chainlink feed to mirror
 *   real         "Chainlink": a live Chainlink feed on the testnet itself (none exist today)
 */
export type SourceTone = "accent" | "neutral" | "guard";

export function priceSourceLabel(p: { symbol: string; feedReal: boolean; kind: string | undefined }): { label: string; tone: SourceTone } {
  if (p.feedReal) return { label: "Chainlink", tone: "accent" };
  if (p.kind === "mainnet-mirror" || p.kind === "chainlink-live") return { label: "Chainlink, mirrored from mainnet", tone: "neutral" };
  return { label: `Public quote (no Chainlink ${p.symbol} feed on Robinhood Chain)`, tone: "guard" };
}
