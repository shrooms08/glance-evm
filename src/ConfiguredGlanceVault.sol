// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {GlanceVault} from "./GlanceVault.sol";

/// @notice Everything an owner would otherwise set one transaction at a time after creating a vault.
/// @param usdg The USDG token the vault holds.
/// @param agent The agent to authorise, or address(0) for none.
/// @param agentDuration How long the agent's permission lasts, in seconds from the block the vault is created in. The
///        expiry is block.timestamp + agentDuration, checked exactly as setAgent checks it (above now, at most
///        MAX_AGENT_TTL ahead), so a caller's clock being ahead of the chain can't push it past the limit. Ignored
///        without an agent.
/// @param tokens Stock tokens to approve, each with its price feed and freshness.
/// @param routers Routers (trading desks) to approve.
/// @param perBuyCap Per-trade cap (raw USDG), as setLimits.
/// @param dailyCap Rolling 24h buy cap (raw USDG), as setLimits.
/// @param dailySellCap Rolling 24h sell cap (raw USDG), as setLimits.
/// @param maxSlippageBps Slippage bound versus the oracle, as setLimits.
/// @param weekendCapBps Fraction of the caps while the market is closed, as setLimits.
/// @param sequencerUptimeFeed Chainlink L2 sequencer uptime feed, or address(0) where the chain has none.
struct VaultConfig {
    address usdg;
    address agent;
    uint64 agentDuration;
    TokenInit[] tokens;
    address[] routers;
    uint256 perBuyCap;
    uint256 dailyCap;
    uint256 dailySellCap;
    uint16 maxSlippageBps;
    uint16 weekendCapBps;
    address sequencerUptimeFeed;
}

/// @notice One stock token: approved with `priceFeed`, and its freshness thresholds. Freshness (0, 0) keeps the
///         defaults setTokenApproval gives a newly approved token.
struct TokenInit {
    address token;
    address priceFeed;
    uint32 openMaxAge;
    uint32 closedMaxAge;
}

/// @title ConfiguredGlanceVault
/// @notice A GlanceVault that arrives fully configured and funded: its constructor applies a VaultConfig through the
///         very same internal functions the owner setters use (same checks, same errors, same events, in the order
///         the step-by-step setup sends them), then records the initial deposit. It has no functions of its own: once
///         constructed it is a GlanceVault, owned by `owner_` alone.
/// @dev Deployed by GlanceVaultFactoryV2 with CREATE2. The factory moves `initialDeposit` USDG from the owner to this
///      contract's precomputed address before deploying it, so the factory itself never holds USDG, never holds an
///      allowance and never has any role on the vault. The factory checks the owner's transfer delivered the full
///      amount (balance after minus balance before, so fee-on-transfer shortfalls revert even if someone donated to
///      the address first); the constructor re-checks the vault holds at least that much.
///      Anything sent to the address before creation (USDG, stock tokens) belongs to the vault, and so to its owner,
///      who can withdraw it; it never makes creation revert. Deposited records the owner's deposit only, not
///      donations. ETH sent there stays inert: the vault has no ETH functions.
contract ConfiguredGlanceVault is GlanceVault {
    constructor(address owner_, VaultConfig memory config, uint256 initialDeposit) GlanceVault(owner_, config.usdg) {
        _setLimits(config.perBuyCap, config.dailyCap, config.dailySellCap, config.maxSlippageBps, config.weekendCapBps);

        for (uint256 i; i < config.tokens.length; ++i) {
            TokenInit memory t = config.tokens[i];
            _setTokenApproval(t.token, t.priceFeed, true);
            if (t.openMaxAge != 0 || t.closedMaxAge != 0) _setTokenFreshness(t.token, t.openMaxAge, t.closedMaxAge);
        }

        for (uint256 i; i < config.routers.length; ++i) {
            _setRouterApproval(config.routers[i], true);
        }

        if (config.sequencerUptimeFeed != address(0)) _setSequencerUptimeFeed(config.sequencerUptimeFeed);

        if (config.agent != address(0)) {
            // Computed on chain from this block's time, then checked exactly as setAgent checks an expiry.
            uint256 expiry = block.timestamp + config.agentDuration;
            if (expiry > type(uint64).max) revert InvalidAgentExpiry(type(uint64).max);
            _setAgent(config.agent, uint64(expiry));
        }

        if (initialDeposit != 0) {
            // At least (never exactly): a donation to this address before creation only adds to it.
            uint256 held = usdg.balanceOf(address(this));
            if (held < initialDeposit) revert InsufficientBalance(held, initialDeposit);
            emit Deposited(initialDeposit);
        }
    }
}
