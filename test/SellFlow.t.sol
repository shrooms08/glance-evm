// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {GlanceVault} from "../src/GlanceVault.sol";
import {GlanceVaultFactory} from "../src/GlanceVaultFactory.sol";
import {MarketStatusLib} from "../src/MarketStatusLib.sol";
import {StockDesk} from "../src/testnet/StockDesk.sol";
import {TestPriceFeed} from "../src/testnet/TestPriceFeed.sol";
import {TestStockToken} from "../src/testnet/TestStockToken.sol";
import {TestUSDG} from "../src/testnet/TestUSDG.sol";

/// @notice Selling, as Glance does it, on a simulated chain with the real contracts (vault, testnet desk, feed, tokens).
///         The shares are worked out exactly as the API does (dollars at the oracle price, rounded down; half; all),
///         the agent calls sell() with the desk's quote as the floor, and the USDG lands back in the vault. Every
///         refusal the API explains is the vault's own: the caps (25% while the market is closed), the balance, zero.
contract SellFlowTest is Test {
    uint256 internal constant START = 1_790_000_000;
    int256 internal constant PRICE = 370e8; // $370.00, 8 decimals like Chainlink

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");

    TestUSDG internal usdg;
    TestStockToken internal tsla;
    TestPriceFeed internal feed;
    StockDesk internal desk;
    GlanceVault internal vault;

    function setUp() public {
        vm.warp(START);
        vm.startPrank(owner);
        usdg = new TestUSDG(owner);
        tsla = new TestStockToken("TSLA Test Stock (Glance testnet stand-in)", "TSLA", 18, owner);
        feed = new TestPriceFeed(8, "TSLA / USD", PRICE, owner);
        desk = new StockDesk(address(usdg), owner);
        desk.setFeed(address(tsla), address(feed));
        usdg.mint(owner, 1_000_000e6);
        usdg.approve(address(desk), 1_000_000e6);
        desk.seed(address(usdg), 1_000_000e6);

        vault = GlanceVault(new GlanceVaultFactory().createVault(address(usdg)));
        vault.setTokenApproval(address(tsla), address(feed), true);
        vault.setRouterApproval(address(desk), true);
        vault.setAgent(agent, uint64(block.timestamp + 7 days));
        // The vault holds 10 TSLA ($3,700) and no USDG yet.
        tsla.mint(address(vault), 10e18);
        vm.stopPrank();
    }

    /// @dev The API's dollars-to-shares: usdg * 10^(priceDecimals + tokenDecimals) / (price * 10^usdgDecimals), rounded down.
    function _sharesFor(uint256 usdgAmount) internal pure returns (uint256) {
        return usdgAmount * 1e26 / (uint256(PRICE) * 1e6);
    }

    /// @dev The oracle value the vault counts against its caps (MarketStatusLib.tokenToUsdgAmount).
    function _value(uint256 shares) internal pure returns (uint256) {
        return shares * uint256(PRICE) / 1e20;
    }

    function _sell(uint256 shares) internal returns (uint256 usdgOut) {
        uint256 quote = desk.quoteSell(address(tsla), shares);
        vm.prank(agent);
        usdgOut = vault.sell(address(tsla), address(desk), shares, quote);
        assertEq(usdgOut, quote, "filled at the desk's quote");
    }

    function test_sellTenDollarsOfTesla_usdgLandsBackInTheVault() public {
        uint256 shares = _sharesFor(10e6);
        assertEq(shares, 27_027_027_027_027_027); // 0.027027... TSLA, the same number the API quotes
        assertLe(_value(shares), 10e6, "never worth more than was asked");
        assertGe(_value(shares), 10e6 - 1);

        uint256 usdgBefore = usdg.balanceOf(address(vault));
        uint256 usdgOut = _sell(shares);

        assertEq(usdg.balanceOf(address(vault)), usdgBefore + usdgOut, "the USDG is in the vault");
        assertEq(usdgOut, _value(shares) * 9_970 / 10_000, "the oracle value less the desk's 0.3% spread");
        assertEq(tsla.balanceOf(address(vault)), 10e18 - shares);
        assertEq(usdg.balanceOf(agent), 0, "the agent never holds the proceeds");
        assertEq(vault.soldInWindow(), _value(shares), "counted against the sell cap at its oracle value");
        assertEq(vault.spentInWindow(), 0, "a sell never uses the buy budget");
    }

    function test_sellHalfThenAll_leavesNothing() public {
        // Keep each sale under the $100 per-trade cap: 0.5 TSLA ($185) would be over it, so hold 0.25 TSLA ($92.50).
        vm.prank(owner);
        vault.withdraw(address(tsla), 10e18 - 0.25e18);

        uint256 half = tsla.balanceOf(address(vault)) / 2;
        uint256 first = _sell(half);
        uint256 rest = tsla.balanceOf(address(vault));
        uint256 second = _sell(rest);

        assertEq(tsla.balanceOf(address(vault)), 0, "all of it sold");
        assertEq(usdg.balanceOf(address(vault)), first + second);

        // Nothing left: the API refuses before asking (NOTHING_HELD); the vault itself would refuse a zero sale.
        vm.prank(agent);
        vm.expectRevert(GlanceVault.ZeroAmount.selector);
        vault.sell(address(tsla), address(desk), 0, 0);
    }

    function test_marketClosed_eachTradeCappedAt25() public {
        vm.prank(owner);
        feed.setUpdatedAt(block.timestamp - 30 hours); // older than 20h, younger than 96h: CLOSED

        uint256 forty = _sharesFor(40e6);
        uint256 quote = desk.quoteSell(address(tsla), forty);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, _value(forty), 25e6));
        vault.sell(address(tsla), address(desk), forty, quote);

        // "Want me to sell $25 worth instead?": that goes through.
        uint256 usdgOut = _sell(_sharesFor(25e6));
        assertEq(usdg.balanceOf(address(vault)), usdgOut);
    }

    function test_dailySellCap_500OpenThen125Closed() public {
        for (uint256 i = 0; i < 5; i++) {
            _sell(_sharesFor(100e6));
        }
        uint256 used = vault.soldInWindow();
        assertLe(used, 500e6);

        uint256 more = _sharesFor(10e6);
        uint256 quote = desk.quoteSell(address(tsla), more);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.ExceedsDailySellCap.selector, used, _value(more), 500e6));
        vault.sell(address(tsla), address(desk), more, quote);

        // With the market closed, the day's sell cap is 25% of $500: already over it.
        vm.prank(owner);
        feed.setUpdatedAt(block.timestamp - 30 hours);
        (,, uint256 closedSellCap) = vault.effectiveCaps(MarketStatusLib.MarketState.CLOSED);
        assertEq(closedSellCap, 125e6);
    }

    function test_sellMoreThanHeld_refusedByTheBalance() public {
        vm.prank(owner);
        vault.withdraw(address(tsla), 10e18 - 0.01e18); // holds 0.01 TSLA ($3.70)
        uint256 ten = _sharesFor(10e6);
        uint256 quote = desk.quoteSell(address(tsla), ten);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.InsufficientBalance.selector, 0.01e18, ten));
        vault.sell(address(tsla), address(desk), ten, quote);
    }
}
