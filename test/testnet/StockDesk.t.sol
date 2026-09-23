// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {GlanceVault} from "../../src/GlanceVault.sol";
import {GlanceVaultFactory} from "../../src/GlanceVaultFactory.sol";
import {StockDesk} from "../../src/testnet/StockDesk.sol";
import {TestPriceFeed} from "../../src/testnet/TestPriceFeed.sol";
import {TestStockToken} from "../../src/testnet/TestStockToken.sol";
import {TestUSDG} from "../../src/testnet/TestUSDG.sol";

contract StockDeskTest is Test {
    uint256 internal constant START = 1_790_000_000;
    uint256 internal constant BPS = 10_000;
    uint16 internal constant SPREAD = 30;
    int256 internal constant TSLA_PRICE = 380e8; // $380.00, 8 decimals like Chainlink
    int256 internal constant SIX_DP_PRICE = 50e8; // $50.00

    address internal owner = makeAddr("owner");
    address internal trader = makeAddr("trader");

    TestUSDG internal usdg;
    TestStockToken internal tsla; // 18 decimals, like the real Robinhood test tokens
    TestStockToken internal six; // 6 decimals
    TestPriceFeed internal tslaFeed;
    TestPriceFeed internal sixFeed;
    StockDesk internal desk;

    function setUp() public {
        vm.warp(START);
        vm.startPrank(owner);
        usdg = new TestUSDG(owner);
        tsla = new TestStockToken("TSLA Test Stock (Glance testnet stand-in)", "TSLA", 18, owner);
        six = new TestStockToken("SIX Test Stock (Glance testnet stand-in)", "SIX", 6, owner);
        tslaFeed = new TestPriceFeed(8, "TSLA / USD", TSLA_PRICE, owner);
        sixFeed = new TestPriceFeed(8, "SIX / USD", SIX_DP_PRICE, owner);
        desk = new StockDesk(address(usdg), owner);
        desk.setFeed(address(tsla), address(tslaFeed));
        desk.setFeed(address(six), address(sixFeed));

        _seed(address(usdg), 1_000_000e6);
        _seed(address(tsla), 1_000e18);
        _seed(address(six), 1_000e6);

        usdg.mint(trader, 100_000e6);
        tsla.mint(trader, 100e18);
        six.mint(trader, 100e6);
        vm.stopPrank();

        vm.startPrank(trader);
        usdg.approve(address(desk), type(uint256).max);
        tsla.approve(address(desk), type(uint256).max);
        six.approve(address(desk), type(uint256).max);
        vm.stopPrank();
    }

    function _seed(address token, uint256 amount) internal {
        if (token == address(usdg)) usdg.mint(owner, amount);
        else TestStockToken(token).mint(owner, amount);
        TestStockToken(token).approve(address(desk), amount);
        desk.seed(token, amount);
    }

    function _lessSpread(uint256 x) internal pure returns (uint256) {
        return x * (BPS - SPREAD) / BPS;
    }

    // ---------------------------------------------------------------------
    // Pricing
    // ---------------------------------------------------------------------

    function test_defaults() public view {
        assertEq(desk.spreadBps(), desk.DEFAULT_SPREAD_BPS());
        assertEq(desk.DEFAULT_SPREAD_BPS(), 30);
        assertEq(desk.usdgDecimals(), 6);
    }

    function test_buy_pricedOffFeedWithSpread() public {
        // $380 buys exactly 1 TSLA at the oracle price, minus the 0.30% spread.
        uint256 expected = _lessSpread(1e18);
        assertEq(desk.quoteBuy(address(tsla), 380e6), expected);

        vm.prank(trader);
        uint256 out = desk.swapUsdgForToken(address(tsla), 380e6, expected, trader);

        assertEq(out, expected);
        assertEq(tsla.balanceOf(trader), 100e18 + expected);
        assertEq(usdg.balanceOf(trader), 100_000e6 - 380e6);
        assertEq(desk.inventory(address(tsla)), 1_000e18 - expected);
        assertEq(desk.inventory(address(usdg)), 1_000_000e6 + 380e6);
    }

    function test_sell_pricedOffFeedWithSpread() public {
        // 2 TSLA at $380 = $760, minus the spread.
        uint256 expected = _lessSpread(760e6);
        assertEq(desk.quoteSell(address(tsla), 2e18), expected);

        vm.prank(trader);
        uint256 out = desk.swapTokenForUsdg(address(tsla), 2e18, expected, trader);

        assertEq(out, expected);
        assertEq(usdg.balanceOf(trader), 100_000e6 + expected);
        assertEq(tsla.balanceOf(trader), 98e18);
    }

    function test_spread_isConfigurableAndCapped() public {
        vm.prank(owner);
        desk.setSpread(0);
        assertEq(desk.quoteBuy(address(tsla), 380e6), 1e18, "zero spread fills at the oracle price");

        vm.prank(owner);
        desk.setSpread(100);
        assertEq(desk.quoteBuy(address(tsla), 380e6), 0.99e18);

        uint16 tooHigh = desk.MAX_SPREAD_BPS() + 1;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StockDesk.SpreadTooHigh.selector, tooHigh));
        desk.setSpread(tooHigh);
    }

    function test_followsFeedPriceChanges() public {
        vm.prank(owner);
        tslaFeed.setPrice(760e8); // price doubles
        assertEq(desk.quoteBuy(address(tsla), 380e6), _lessSpread(0.5e18));
        assertEq(desk.quoteSell(address(tsla), 1e18), _lessSpread(760e6));
    }

    // ---------------------------------------------------------------------
    // Decimals
    // ---------------------------------------------------------------------

    function test_sixDecimalToken_bothDirections() public {
        // $100 at $50 = 2 SIX = 2e6 raw, minus spread.
        uint256 buyOut = _lessSpread(2e6);
        vm.prank(trader);
        assertEq(desk.swapUsdgForToken(address(six), 100e6, buyOut, trader), buyOut);

        // 3 SIX at $50 = $150, minus spread.
        uint256 sellOut = _lessSpread(150e6);
        vm.prank(trader);
        assertEq(desk.swapTokenForUsdg(address(six), 3e6, sellOut, trader), sellOut);
    }

    function test_eighteenDecimalQuote_withEighteenDecimalFeed() public {
        vm.startPrank(owner);
        TestPriceFeed feed18 = new TestPriceFeed(18, "TSLA / USD (18dp)", 380e18, owner);
        desk.setFeed(address(tsla), address(feed18));
        vm.stopPrank();
        assertEq(desk.quoteBuy(address(tsla), 380e6), _lessSpread(1e18), "feed decimals do not change the result");
    }

    function testFuzz_quotesMatchOracleLessSpread(uint256 usdgIn, int256 price) public {
        usdgIn = bound(usdgIn, 1e6, 100_000e6);
        price = int256(bound(uint256(price), 1e8, 10_000e8));
        vm.prank(owner);
        tslaFeed.setPrice(price);

        uint256 fair = usdgIn * 1e20 / uint256(price); // 10^(8 + 18 - 6)
        assertEq(desk.quoteBuy(address(tsla), usdgIn), fair * (BPS - SPREAD) / BPS);
    }

    // ---------------------------------------------------------------------
    // Round trip
    // ---------------------------------------------------------------------

    function test_roundTrip_losesOnlyTheSpread() public {
        uint256 usdgIn = 10_000e6;
        vm.startPrank(trader);
        uint256 tokens = desk.swapUsdgForToken(address(tsla), usdgIn, 1, trader);
        uint256 back = desk.swapTokenForUsdg(address(tsla), tokens, 1, trader);
        vm.stopPrank();

        // Each leg keeps (1 - spread): back = usdgIn * (1 - s)^2, up to 1 unit of rounding.
        uint256 expected = usdgIn * (BPS - SPREAD) * (BPS - SPREAD) / (BPS * BPS);
        assertApproxEqAbs(back, expected, 1);
        assertLt(back, usdgIn);
        // Loss is just under 2 * spread (0.5991% here).
        assertApproxEqAbs(usdgIn - back, usdgIn * 2 * SPREAD / BPS, usdgIn * SPREAD * SPREAD / (BPS * BPS) + 1);
    }

    function testFuzz_roundTrip_neverProfitable(uint256 usdgIn) public {
        usdgIn = bound(usdgIn, 1e6, 100_000e6);
        vm.startPrank(trader);
        uint256 tokens = desk.swapUsdgForToken(address(tsla), usdgIn, 1, trader);
        uint256 back = desk.swapTokenForUsdg(address(tsla), tokens, 1, trader);
        vm.stopPrank();
        assertLe(back, _lessSpread(_lessSpread(usdgIn)) + 1);
    }

    // ---------------------------------------------------------------------
    // Reverts
    // ---------------------------------------------------------------------

    function test_revert_buy_insufficientInventory() public {
        vm.prank(owner);
        desk.withdraw(address(tsla), owner, 999e18); // leave 1 TSLA
        uint256 needed = desk.quoteBuy(address(tsla), 760e6); // ~2 TSLA
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(StockDesk.InsufficientInventory.selector, address(tsla), 1e18, needed));
        desk.swapUsdgForToken(address(tsla), 760e6, 0, trader);
    }

    function test_revert_sell_insufficientInventory() public {
        vm.prank(owner);
        desk.withdraw(address(usdg), owner, 1_000_000e6 - 100e6); // leave $100
        uint256 needed = desk.quoteSell(address(tsla), 1e18);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(StockDesk.InsufficientInventory.selector, address(usdg), 100e6, needed));
        desk.swapTokenForUsdg(address(tsla), 1e18, 0, trader);
    }

    function test_revert_belowMinOut() public {
        uint256 quote = desk.quoteBuy(address(tsla), 380e6);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(StockDesk.BelowMinOut.selector, quote, quote + 1));
        desk.swapUsdgForToken(address(tsla), 380e6, quote + 1, trader);
    }

    function test_revert_unlistedToken() public {
        TestStockToken other = new TestStockToken("X", "X", 18, owner);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(StockDesk.NotListed.selector, address(other)));
        desk.swapUsdgForToken(address(other), 1e6, 0, trader);
    }

    function test_revert_stalePrice_butWeekendAgeStillFills() public {
        vm.prank(owner);
        tslaFeed.setUpdatedAt(block.timestamp - 30 hours); // simulated weekend: still fills
        assertGt(desk.quoteBuy(address(tsla), 380e6), 0);

        uint256 stale = block.timestamp - desk.MAX_PRICE_AGE() - 1;
        vm.prank(owner);
        tslaFeed.setUpdatedAt(stale);
        vm.expectRevert(abi.encodeWithSelector(StockDesk.StalePrice.selector, address(tsla), stale));
        desk.quoteBuy(address(tsla), 380e6);
    }

    function test_revert_zeroOutput() public {
        vm.prank(trader);
        vm.expectRevert(StockDesk.ZeroOutput.selector);
        desk.swapTokenForUsdg(address(tsla), 1, 0, trader); // 1 wei of TSLA is worth < 1 raw USDG
    }

    function test_revert_ownerOnlyAdmin() public {
        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, trader));
        desk.setFeed(address(tsla), address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, trader));
        desk.setSpread(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, trader));
        desk.withdraw(address(usdg), trader, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, trader));
        desk.seed(address(usdg), 1);
        vm.stopPrank();
    }

    function test_withdraw_returnsInventory() public {
        vm.prank(owner);
        desk.withdraw(address(tsla), owner, 10e18);
        assertEq(tsla.balanceOf(owner), 10e18);
        assertEq(desk.inventory(address(tsla)), 990e18);
    }

    // ---------------------------------------------------------------------
    // End to end with the vault
    // ---------------------------------------------------------------------

    /// @dev The desk's 0.30% spread fits inside the vault's default 1% slippage (and 0.5% when closed), so an agent
    ///      passing the desk's own quote as minOut clears the vault's oracle floor.
    function test_vaultTradesThroughDesk_openAndClosed() public {
        address agent = makeAddr("agent");
        GlanceVaultFactory factory = new GlanceVaultFactory();
        vm.startPrank(owner);
        GlanceVault vault = GlanceVault(factory.createVault(address(usdg)));
        vault.setAgent(agent, uint64(block.timestamp + 7 days));
        vault.setTokenApproval(address(tsla), address(tslaFeed), true);
        vault.setRouterApproval(address(desk), true);
        usdg.mint(owner, 1_000e6);
        usdg.approve(address(vault), 1_000e6);
        vault.deposit(1_000e6);
        vm.stopPrank();

        vm.startPrank(agent);
        uint256 got = vault.buy(address(tsla), address(desk), 100e6, desk.quoteBuy(address(tsla), 100e6));
        assertEq(tsla.balanceOf(address(vault)), got);
        vault.sell(address(tsla), address(desk), got / 2, desk.quoteSell(address(tsla), got / 2));
        vm.stopPrank();

        vm.prank(owner);
        tslaFeed.setUpdatedAt(block.timestamp - 30 hours); // weekend
        uint256 quote = desk.quoteBuy(address(tsla), 20e6);
        vm.prank(agent);
        vault.buy(address(tsla), address(desk), 20e6, quote);
    }
}
