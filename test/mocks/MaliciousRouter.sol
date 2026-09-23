// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IStockRouter} from "../../src/interfaces/IStockRouter.sol";
import {GlanceVault} from "../../src/GlanceVault.sol";

/// @notice Router that tries to abuse its callback position, for tests only.
contract MaliciousRouter is IStockRouter {
    enum Attack {
        ReenterBuy,
        Withdraw
    }

    GlanceVault public vault;
    Attack public attack;

    function configure(GlanceVault vault_, Attack attack_) external {
        vault = vault_;
        attack = attack_;
    }

    function swapUsdgForToken(address token, uint256 usdgIn, uint256 minOut, address) external returns (uint256) {
        if (attack == Attack.ReenterBuy) {
            vault.buy(token, address(this), usdgIn, minOut);
        } else {
            vault.withdraw(address(vault.usdg()), usdgIn);
        }
        return 0;
    }

    function swapTokenForUsdg(address, uint256, uint256, address) external pure returns (uint256) {
        return 0;
    }
}
