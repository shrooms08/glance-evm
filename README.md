# Glance EVM

Buy tokenized stocks from any headline, through an agent that cannot overspend.

Built for the Arbitrum Open House Singapore Buildathon (Sep 14 to Oct 4, 2026), targeting Robinhood Chain.

- An onchain vault holds the funds and enforces every limit: per-buy cap, rolling 24h cap, approved token list, agent expiry, pause, and a maximum price deviation checked against Chainlink.
- A weekend guard reads Chainlink's market status. When the stock market is closed and the price goes stale, the vault tightens caps and refuses trades.
- The browser extension recognises companies on a page and buys in one tap, with no wallet popup.

Status: in development. Contracts, deployed addresses and demo video to follow.
