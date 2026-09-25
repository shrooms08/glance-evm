/**
 * The price freshness Glance gives every token it sets up (stocks and the SPY/QQQ stand-ins alike): a price up to
 * 20 hours old counts as the market being open, up to 96 hours as closed (a weekend plus margin), older is too old to
 * trade on. The console writes these with setTokenFreshness; FactoryV2 vaults get them in their creation config.
 *
 * Chainlink's Robinhood Chain feeds update on a 0.5% move (and a heartbeat), so a quiet index ETF can go hours
 * without an update while the market is open: 20 hours covers a normal trading day.
 */
export const STOCK_FRESHNESS = { openMaxAge: 72_000, closedMaxAge: 345_600 } as const;
