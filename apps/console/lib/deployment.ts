/**
 * Every address the console uses comes from deployments/46630.json, the same record the API and the scripts read.
 */
import { getAddress, type Address } from "viem";

import record from "../../../deployments/46630.json";

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
    label: "Paxos USDG demo vault",
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
    label: "TestUSDG demo vault",
    usdgLabel: "TestUSDG",
    faucet: "TestUSDG.faucet(amount): 1,000 a day per address",
  },
].sort((a, b) => Number(b.primary) - Number(a.primary));

export const primaryVault = demoVaults[0]!;
export const factory = getAddress(record.factory.address);

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

/** What `make create-vault` configures (script/CreateVault.s.sol, VaultSetup): the console mirrors it exactly. */
export const VAULT_SETUP = {
  /** Price freshness per token while the market is open (20h) and closed (96h), in seconds. */
  openMaxAge: 72_000,
  closedMaxAge: 345_600,
  /** A new agent permission lasts 29 days; one with under 7 days left is renewed. */
  agentTtlSeconds: 29 * 86_400,
  agentMinLeftSeconds: 7 * 86_400,
  /** Default deposit, in whole USDG. */
  defaultDeposit: "10",
} as const;
