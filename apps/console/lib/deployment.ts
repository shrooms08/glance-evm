/**
 * Every address the console uses comes from deployments/46630.json, the same record the API and the scripts read.
 */
import { factoryV2Address, glanceFactories } from "@glance/core/factories";
import { getAddress, type Address } from "viem";

import record from "../../../deployments/46630.json";
import { STOCK_FRESHNESS } from "@glance/core/freshness";

export const CHAIN_ID = 46_630;
if (record.chainId !== CHAIN_ID) throw new Error(`deployments/46630.json is for chain ${record.chainId}`);

export const SYMBOLS = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"] as const;
export type StockSymbol = (typeof SYMBOLS)[number];

export interface DemoVault {
  key: "paxos" | "test";
  address: Address;
  usdg: Address;
  desk: Address;
  agent: Address;
  owner: Address;
  primary: boolean;
  label: string;
  usdgLabel: string;
  faucet: string;
}

const paxos = record.demoVaultPaxosUSDG;
const test = record.demoVaultTestUSDG;

export const demoVaults: DemoVault[] = [
  {
    key: "paxos" as const,
    address: getAddress(paxos.address),
    usdg: getAddress(paxos.usdg),
    desk: getAddress(paxos.stockDesk),
    agent: getAddress(paxos.agent),
    owner: getAddress(paxos.owner),
    primary: record.primaryVault === "demoVaultPaxosUSDG",
    label: "Paxos USDG team vault",
    usdgLabel: "Paxos USDG",
    faucet: "https://faucet.paxos.com/",
  },
  {
    key: "test" as const,
    address: getAddress(test.address),
    usdg: getAddress(test.usdg),
    desk: getAddress(test.stockDesk),
    agent: getAddress(test.agent),
    owner: getAddress(test.owner),
    primary: record.primaryVault === "demoVaultTestUSDG",
    label: "TestUSDG team vault",
    usdgLabel: "TestUSDG",
    faucet: "TestUSDG.faucet(amount): 1,000 a day per address",
  },
].sort((a, b) => Number(b.primary) - Number(a.primary));

export const primaryVault = demoVaults[0]!;
export const factory = getAddress(record.factory.address);
/**
 * Every vault factory in the record: the original (step-by-step setup) and, once deployed, GlanceVaultFactoryV2 (one
 * transaction to a configured, funded vault). Vaults from either are ordinary GlanceVaults.
 */
export const factories = glanceFactories(record as Parameters<typeof glanceFactories>[0]).map((f) => ({ ...f, address: getAddress(f.address) }));
/** The one-transaction factory, or null while it isn't deployed: Get started then uses the step-by-step setup. */
export const factoryV2: Address | null = (() => {
  const a = factoryV2Address(record as Parameters<typeof factoryV2Address>[0]);
  return a ? getAddress(a) : null;
})();
/** The chain's L2 sequencer uptime feed (zero on Robinhood Chain testnet, which publishes none). */
export const sequencerUptimeFeed = getAddress(record.sequencerUptimeFeed);

export interface Stock {
  symbol: StockSymbol;
  token: Address;
  tokenDecimals: number;
  feed: Address;
}

export const stocks: Stock[] = SYMBOLS.map((symbol) => {
  const s = record.stocks[symbol];
  return { symbol, token: getAddress(s.token), tokenDecimals: s.tokenDecimals, feed: getAddress(s.feed) };
});

/** The ETF stand-ins (testnet stand-ins mirrored from Robinhood Chain mainnet's Chainlink SPY and QQQ feeds). */
export const ETF_SYMBOLS = ["SPY", "QQQ"] as const;
export type EtfSymbol = (typeof ETF_SYMBOLS)[number];
export interface EtfStock {
  symbol: EtfSymbol;
  token: Address;
  tokenDecimals: number;
  feed: Address;
}

/** The ETFs a deployment record lists (none until `make deploy-etf-standins` has run). */
export function etfsIn(recordStocks: Record<string, { token?: string; feed?: string; tokenDecimals?: number; skipped?: boolean } | undefined>): EtfStock[] {
  return ETF_SYMBOLS.flatMap((symbol) => {
    const s = recordStocks[symbol];
    if (!s || s.skipped || !s.token || !s.feed) return [];
    return [{ symbol, token: getAddress(s.token), tokenDecimals: s.tokenDecimals ?? 18, feed: getAddress(s.feed) }];
  });
}

export const etfs: EtfStock[] = etfsIn(record.stocks as Record<string, { token?: string; feed?: string; tokenDecimals?: number; skipped?: boolean }>);

/** What `make create-vault` configures (script/CreateVault.s.sol, VaultSetup): the console mirrors it exactly. */
export const VAULT_SETUP = {
  /** Price freshness per token while the market is open (20h) and closed (96h), in seconds. */
  openMaxAge: STOCK_FRESHNESS.openMaxAge,
  closedMaxAge: STOCK_FRESHNESS.closedMaxAge,
  /** A new agent permission lasts 29 days; one with under 7 days left is renewed. */
  agentTtlSeconds: 29 * 86_400,
  agentMinLeftSeconds: 7 * 86_400,
  /**
   * A new vault's agent permission (one-transaction setup), as a duration: the vault adds it to its own block time,
   * so the full 30-day maximum is safe from clock skew.
   */
  newAgentDurationSeconds: 30 * 86_400,
  /** Default limits, as whole USDG and basis points: the vault's own defaults. */
  perTradeWhole: 100n,
  dailyWhole: 500n,
  maxSlippageBps: 100,
  weekendCapBps: 2_500,
  /** Default deposit, in whole USDG. */
  defaultDeposit: "10",
} as const;
