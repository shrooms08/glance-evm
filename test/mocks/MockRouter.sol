// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IStockRouter} from "../../src/interfaces/IStockRouter.sol";
import {MarketStatusLib} from "../../src/MarketStatusLib.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Router that swaps at a settable price by minting the output token, for tests only.
/// @dev `price` uses the same convention as the feed: USD per whole token, scaled by 10^PRICE_DECIMALS.
///      `outputBps` scales the fair output (10_000 = fair). When `shortchange` is set the router ignores minOut,
///      delivers one unit less than it, and still reports minOut, to exercise the vault's balance-delta check.
contract MockRouter is IStockRouter {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint8 public constant PRICE_DECIMALS = 8;

    MockERC20 public immutable usdg;
    uint256 public price;
    uint256 public outputBps = BPS;
    bool public shortchange;

    error RouterMinOut(uint256 out, uint256 minOut);

    constructor(MockERC20 usdg_, uint256 price_) {
        usdg = usdg_;
        price = price_;
    }

    function setPrice(uint256 price_) external {
        price = price_;
    }

    function setOutputBps(uint256 outputBps_) external {
        outputBps = outputBps_;
    }

    function setShortchange(bool shortchange_) external {
        shortchange = shortchange_;
    }

    function swapUsdgForToken(address token, uint256 usdgIn, uint256 minOut, address to)
        external
        returns (uint256 out)
    {
        IERC20(address(usdg)).safeTransferFrom(msg.sender, address(this), usdgIn);
        uint256 fair = MarketStatusLib.usdgToTokenAmount(
            usdgIn, usdg.decimals(), price, PRICE_DECIMALS, IERC20Metadata(token).decimals()
        );
        return _deliver(MockERC20(token), fair, minOut, to);
    }

    function swapTokenForUsdg(address token, uint256 tokensIn, uint256 minOut, address to)
        external
        returns (uint256 out)
    {
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        uint256 fair = MarketStatusLib.tokenToUsdgAmount(
            tokensIn, IERC20Metadata(token).decimals(), price, PRICE_DECIMALS, usdg.decimals()
        );
        return _deliver(usdg, fair, minOut, to);
    }

    function _deliver(MockERC20 outToken, uint256 fair, uint256 minOut, address to) internal returns (uint256) {
        if (shortchange) {
            uint256 lie = minOut == 0 ? 0 : minOut - 1;
            outToken.mint(to, lie);
            return minOut;
        }
        uint256 out = Math.mulDiv(fair, outputBps, BPS);
        if (out < minOut) revert RouterMinOut(out, minOut);
        outToken.mint(to, out);
        return out;
    }
}
