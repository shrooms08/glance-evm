/**
 * The Prices page shows the live market price big (with a live dot and its age), and underneath the price the vault
 * actually trades at; a vault that never added SPY/QQQ says "Not in this vault", never "Price too old".
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MarketChip } from "../components/MarketChip";
import type { CatalogStock, FeedStatus } from "../lib/api";
import { PriceCard } from "../components/PriceCard";

afterEach(cleanup);

const tesla: CatalogStock = {
  symbol: "TSLA",
  name: "Tesla",
  token: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E",
  tokenDecimals: 18,
  tokenReal: true,
  feed: "0xb856AB851b58B3d0436d62b465A9e92c481E9e9f",
  feedReal: false,
  priceSourceKind: "mainnet-mirror",
  priceSource: "Chainlink TSLA/USD on Robinhood Chain mainnet",
  mainnetFeed: "0x0000000000000000000000000000000000000002",
};
const now = Math.floor(Date.now() / 1000);
const feed: FeedStatus = { symbol: "TSLA", price: { raw: "37000000000", decimals: 8, value: "370" }, updatedAt: now - 3 * 3600, marketState: "OPEN", source: "mainnet-mirror" };

describe("a price card", () => {
  it("the live price big, with its dot and age; the vault's own price, source and age underneath", () => {
    render(<PriceCard stock={tesla} feed={feed} live={{ price: "373.90", source: "finnhub", quotedAt: now - 4, ageSeconds: 4, fetchedAt: now }} now={now} />);
    expect(screen.getByTestId("live-price").textContent).toBe("$373.90");
    expect(screen.getByText(/live · \d+s old · Finnhub/)).toBeTruthy();
    expect(screen.getByTestId("vault-price").textContent).toMatch(/^Vault trades at \$370 · Chainlink, mirrored from mainnet · 3\.0 h/);
  });

  it("no live quote: the vault's price, saying so", () => {
    render(<PriceCard stock={tesla} feed={feed} live={null} now={now} />);
    expect(screen.queryByTestId("live-price")).toBeNull();
    expect(screen.getByText("The vault's price (no live quote right now).")).toBeTruthy();
  });
});

describe("the market chip", () => {
  it("a token the vault never added: \"Not in this vault\", not \"Price too old\"", () => {
    render(<MarketChip state="OPEN" allowed={false} />);
    expect(screen.getByText("Not in this vault")).toBeTruthy();
    cleanup();
    render(<MarketChip state="STALE" />);
    expect(screen.getByText("Price too old")).toBeTruthy();
  });
});
