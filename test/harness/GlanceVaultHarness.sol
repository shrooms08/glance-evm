// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {GlanceVault} from "../../src/GlanceVault.sol";
import {MarketStatusLib} from "../../src/MarketStatusLib.sol";

/// @notice GlanceVault with test-only hooks for reaching states the public setters refuse. Never deploy this.
contract GlanceVaultHarness is GlanceVault {
    constructor(address owner_, address usdg_) GlanceVault(owner_, usdg_) {}

    /// @notice Marks `token` approved with no price feed, which `setTokenApproval` rejects.
    function forceApproveWithoutFeed(address token) external {
        tokenConfig[token] = TokenConfig({
            approved: true,
            priceFeed: address(0),
            openMaxAge: MarketStatusLib.DEFAULT_OPEN_MAX_AGE,
            closedMaxAge: MarketStatusLib.DEFAULT_CLOSED_MAX_AGE
        });
    }
}
