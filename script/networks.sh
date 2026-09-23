#!/usr/bin/env bash
# Sourced by the other scripts: maps a network name to its RPC, chain id and Blockscout verifier.
case "$1" in
  robinhood)
    NETWORK_NAME="Robinhood Chain testnet"; CHAIN_ID=46630
    RPC="${ROBINHOOD_TESTNET_RPC:-https://rpc.testnet.chain.robinhood.com}"
    VERIFIER_URL="https://explorer.testnet.chain.robinhood.com/api/"
    EXPLORER="https://explorer.testnet.chain.robinhood.com"
    PLAN="factory, StockDesk, TestUSDG, TestPriceFeeds; list the REAL faucet Stock Tokens; seed desk; demoVaultTestUSDG; demoVaultPaxosUSDG + its desk on the REAL Paxos USDG (then make fund-paxos stocks and funds it)"
    ;;
  arbsepolia)
    NETWORK_NAME="Arbitrum Sepolia"; CHAIN_ID=421614
    RPC="${ARBITRUM_SEPOLIA_RPC:-https://sepolia-rollup.arbitrum.io/rpc}"
    VERIFIER_URL="https://arbitrum-sepolia.blockscout.com/api/"
    EXPLORER="https://arbitrum-sepolia.blockscout.com"
    PLAN="factory, StockDesk, TestUSDG, 5 TestStockTokens, 5 TestPriceFeeds; seed desk; demo vault + approvals"
    ;;
  *) echo "unknown network '$1' (expected robinhood or arbsepolia)"; exit 1 ;;
esac
