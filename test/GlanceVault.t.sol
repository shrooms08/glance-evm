// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {GlanceVault} from "../src/GlanceVault.sol";
import {GlanceVaultFactory} from "../src/GlanceVaultFactory.sol";
import {MarketStatusLib} from "../src/MarketStatusLib.sol";
import {RollingSpendLib} from "../src/RollingSpendLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPriceFeed} from "./mocks/MockPriceFeed.sol";
import {MockRouter} from "./mocks/MockRouter.sol";
import {MaliciousRouter} from "./mocks/MaliciousRouter.sol";
import {MockSequencerUptimeFeed} from "./mocks/MockSequencerUptimeFeed.sol";
import {GlanceVaultHarness} from "./harness/GlanceVaultHarness.sol";

/// @dev Shared deployment used by the unit, fuzz and invariant suites.
abstract contract VaultFixture is Test {
    uint256 internal constant START = 1_750_000_000;

    uint8 internal constant USDG_DECIMALS = 6;
    uint8 internal constant STOCK_DECIMALS = 18;
    uint8 internal constant FEED_DECIMALS = 8;
    uint256 internal constant ONE_USDG = 10 ** USDG_DECIMALS;
    int256 internal constant PRICE = 200e8; // $200.00 per share

    uint256 internal constant PER_BUY_CAP = 100 * ONE_USDG;
    uint256 internal constant DAILY_CAP = 500 * ONE_USDG;
    uint256 internal constant DAILY_SELL_CAP = 500 * ONE_USDG;
    uint16 internal constant SLIPPAGE_BPS = 100;
    uint16 internal constant WEEKEND_CAP_BPS = 2_500;
    uint256 internal constant DEPOSIT = 100_000 * ONE_USDG;
    uint64 internal constant AGENT_TTL = 7 days;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal attacker = makeAddr("attacker");

    MockERC20 internal usdg;
    MockERC20 internal stock;
    MockPriceFeed internal feed;
    MockRouter internal router;
    GlanceVaultFactory internal factory;
    GlanceVault internal vault;

    function setUp() public virtual {
        vm.warp(START);

        usdg = new MockERC20("Global Dollar", "USDG", USDG_DECIMALS);
        stock = new MockERC20("Apple tokenized", "AAPLx", STOCK_DECIMALS);
        feed = new MockPriceFeed(FEED_DECIMALS, PRICE);
        router = new MockRouter(usdg, uint256(PRICE));
        factory = new GlanceVaultFactory();

        vm.startPrank(owner);
        vault = GlanceVault(factory.createVault(address(usdg)));
        vault.setAgent(agent, uint64(block.timestamp) + AGENT_TTL);
        vault.setLimits(PER_BUY_CAP, DAILY_CAP, DAILY_SELL_CAP, SLIPPAGE_BPS, WEEKEND_CAP_BPS);
        vault.setTokenApproval(address(stock), address(feed), true);
        vault.setRouterApproval(address(router), true);
        usdg.mint(owner, DEPOSIT);
        usdg.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT);
        vm.stopPrank();
    }

    /// @dev Oracle-implied tokens for `usdgIn` at the fixture price.
    function _quote(uint256 usdgIn) internal pure returns (uint256) {
        return MarketStatusLib.usdgToTokenAmount(usdgIn, USDG_DECIMALS, uint256(PRICE), FEED_DECIMALS, STOCK_DECIMALS);
    }

    function _buy(uint256 usdgIn) internal returns (uint256) {
        vm.prank(agent);
        return vault.buy(address(stock), address(router), usdgIn, _quote(usdgIn));
    }

    function _expectBuyRevert(uint256 usdgIn, bytes memory err) internal {
        uint256 minOut = _quote(usdgIn);
        vm.prank(agent);
        vm.expectRevert(err);
        vault.buy(address(stock), address(router), usdgIn, minOut);
    }

    /// @dev Advances time and marks the feed as freshly updated, so the market reads OPEN.
    function _skipAndRefresh(uint256 dt) internal {
        vm.warp(block.timestamp + dt);
        feed.setUpdatedAt(block.timestamp);
    }

    /// @dev Makes the feed look like the market closed `age` seconds ago.
    function _setFeedAge(uint256 age) internal {
        feed.setUpdatedAt(block.timestamp - age);
    }
}

contract GlanceVaultTest is VaultFixture {
    // ---------------------------------------------------------------------
    // Factory and construction
    // ---------------------------------------------------------------------

    function test_factory_recordsVaultAndOwner() public view {
        assertEq(factory.vaultOf(owner), address(vault));
        assertEq(factory.vaultOf(attacker), address(0));
        assertEq(vault.owner(), owner);
        assertEq(address(vault.usdg()), address(usdg));
        assertEq(vault.usdgDecimals(), USDG_DECIMALS);
    }

    function test_factory_onePerOwner() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(GlanceVaultFactory.VaultAlreadyExists.selector, address(vault)));
        factory.createVault(address(usdg));
    }

    function test_factory_emitsEvent() public {
        vm.expectEmit(true, false, true, false, address(factory));
        emit GlanceVaultFactory.VaultCreated(attacker, address(0), address(usdg));
        vm.prank(attacker);
        factory.createVault(address(usdg));
    }

    function test_factory_rejectsZeroUsdg() public {
        vm.expectRevert(GlanceVaultFactory.ZeroAddress.selector);
        factory.createVault(address(0));
    }

    function test_defaults_scaleWithUsdgDecimals() public {
        MockERC20 usdg18 = new MockERC20("USDG18", "USDG18", 18);
        vm.prank(attacker);
        GlanceVault v = GlanceVault(factory.createVault(address(usdg18)));
        assertEq(v.perBuyCap(), v.DEFAULT_PER_BUY_CAP_WHOLE() * 1e18);
        assertEq(v.dailyCap(), v.DEFAULT_DAILY_CAP_WHOLE() * 1e18);
        assertEq(v.dailySellCap(), v.dailyCap(), "sell cap defaults to the buy cap");
        assertEq(v.maxSlippageBps(), v.DEFAULT_MAX_SLIPPAGE_BPS());
        assertEq(v.weekendCapBps(), v.DEFAULT_WEEKEND_CAP_BPS());
    }

    // ---------------------------------------------------------------------
    // Deposit and withdraw
    // ---------------------------------------------------------------------

    function test_deposit_movesUsdg() public {
        usdg.mint(owner, 50 * ONE_USDG);
        vm.startPrank(owner);
        usdg.approve(address(vault), 50 * ONE_USDG);
        vm.expectEmit(address(vault));
        emit GlanceVault.Deposited(50 * ONE_USDG);
        vault.deposit(50 * ONE_USDG);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(vault)), DEPOSIT + 50 * ONE_USDG);
        assertEq(usdg.balanceOf(owner), 0);
    }

    function test_withdraw_usdgAndStock() public {
        _buy(100 * ONE_USDG);
        uint256 stockHeld = stock.balanceOf(address(vault));

        vm.startPrank(owner);
        vault.withdraw(address(usdg), 1_000 * ONE_USDG);
        vault.withdraw(address(stock), stockHeld);
        vm.stopPrank();

        assertEq(usdg.balanceOf(owner), 1_000 * ONE_USDG);
        assertEq(stock.balanceOf(owner), stockHeld);
        assertEq(stock.balanceOf(address(vault)), 0);
    }

    function test_withdraw_worksWhilePaused() public {
        vm.startPrank(owner);
        vault.setPaused(true);
        vault.withdraw(address(usdg), DEPOSIT);
        vm.stopPrank();
        assertEq(usdg.balanceOf(owner), DEPOSIT);
    }

    function test_revert_withdraw_nonOwner() public {
        vm.prank(attacker);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.withdraw(address(usdg), 1);
    }

    function test_revert_deposit_nonOwner() public {
        vm.prank(attacker);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.deposit(1);
    }

    function test_revert_withdraw_zeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(GlanceVault.ZeroAmount.selector);
        vault.withdraw(address(usdg), 0);
    }

    // ---------------------------------------------------------------------
    // The agent can never extract funds
    // ---------------------------------------------------------------------

    function test_agentCannotCallAnyOwnerFunction() public {
        vm.startPrank(agent);

        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.withdraw(address(usdg), 1);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.withdraw(address(stock), 1);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.deposit(1);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.setAgent(agent, uint64(block.timestamp + 1 days));
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.revokeAgent();
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.setLimits(type(uint128).max, type(uint128).max, type(uint128).max, 1_000, 10_000);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.setSequencerUptimeFeed(address(0));
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.setPaused(false);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.setTokenApproval(address(usdg), address(feed), true);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.setRouterApproval(agent, true);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.setTokenFreshness(address(stock), 1 hours, 7 days);

        vm.stopPrank();
    }

    function test_agentTradesAlwaysSettleIntoVault() public {
        uint256 bought = _buy(100 * ONE_USDG);
        vm.prank(agent);
        vault.sell(address(stock), address(router), bought, 99 * ONE_USDG);

        assertEq(usdg.balanceOf(agent), 0);
        assertEq(stock.balanceOf(agent), 0);
        assertEq(usdg.balanceOf(address(vault)), DEPOSIT, "round trip at oracle price is lossless");
        assertEq(usdg.allowance(address(vault), address(router)), 0, "no lingering USDG allowance");
        assertEq(stock.allowance(address(vault), address(router)), 0, "no lingering stock allowance");
    }

    function test_agentCannotUseUnapprovedRouterAsWithdrawal() public {
        // An agent-controlled "router" that would just keep the USDG is rejected before any approval is granted.
        _expectBuyRevertWithRouter(attacker, abi.encodeWithSelector(GlanceVault.RouterNotApproved.selector, attacker));
        assertEq(usdg.allowance(address(vault), attacker), 0);
    }

    function test_maliciousRouter_cannotReenter() public {
        MaliciousRouter evil = new MaliciousRouter();
        evil.configure(vault, MaliciousRouter.Attack.ReenterBuy);
        vm.prank(owner);
        vault.setRouterApproval(address(evil), true);

        _expectBuyRevertWithRouter(
            address(evil), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
    }

    function test_maliciousRouter_cannotWithdraw() public {
        MaliciousRouter evil = new MaliciousRouter();
        evil.configure(vault, MaliciousRouter.Attack.Withdraw);
        vm.prank(owner);
        vault.setRouterApproval(address(evil), true);

        // Inside the swap callback the router is msg.sender, and it is not the owner.
        _expectBuyRevertWithRouter(address(evil), abi.encodeWithSelector(GlanceVault.NotOwner.selector));
    }

    function _expectBuyRevertWithRouter(address r, bytes memory err) internal {
        uint256 amount = 50 * ONE_USDG;
        uint256 minOut = _quote(amount);
        vm.prank(agent);
        vm.expectRevert(err);
        vault.buy(address(stock), r, amount, minOut);
    }

    // ---------------------------------------------------------------------
    // Buy: happy path
    // ---------------------------------------------------------------------

    function test_buy_withinLimits_movesBalances() public {
        uint256 amount = 100 * ONE_USDG;
        uint256 expected = _quote(amount);
        assertEq(expected, 0.5e18, "100 USDG buys half a $200 share");

        vm.expectEmit(address(vault));
        emit GlanceVault.Bought(
            address(stock),
            address(router),
            amount,
            expected,
            uint256(PRICE),
            MarketStatusLib.MarketState.OPEN,
            PER_BUY_CAP,
            DAILY_CAP
        );
        uint256 out = _buy(amount);

        assertEq(out, expected);
        assertEq(stock.balanceOf(address(vault)), expected);
        assertEq(usdg.balanceOf(address(vault)), DEPOSIT - amount);
        assertEq(usdg.balanceOf(address(router)), amount);
        assertEq(vault.spentInWindow(), amount);
        assertEq(usdg.allowance(address(vault), address(router)), 0);
    }

    function test_buy_acceptsMinOutAtExactSlippageFloor() public {
        uint256 amount = 100 * ONE_USDG;
        uint256 floor = _quote(amount) * (10_000 - SLIPPAGE_BPS) / 10_000;
        router.setOutputBps(10_000 - SLIPPAGE_BPS);
        vm.prank(agent);
        uint256 out = vault.buy(address(stock), address(router), amount, floor);
        assertEq(out, floor);
    }

    // ---------------------------------------------------------------------
    // Buy: every revert path
    // ---------------------------------------------------------------------

    function test_revert_buy_overPerBuyCap() public {
        uint256 amount = PER_BUY_CAP + 1;
        _expectBuyRevert(amount, abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, amount, PER_BUY_CAP));
    }

    function test_revert_buy_overRollingDailyCap() public {
        for (uint256 i; i < 5; ++i) {
            _buy(PER_BUY_CAP);
        }
        _expectBuyRevert(1, abi.encodeWithSelector(GlanceVault.ExceedsDailyCap.selector, DAILY_CAP, 1, DAILY_CAP));
    }

    function test_revert_buy_unapprovedToken() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.TokenNotApproved.selector, address(other)));
        vault.buy(address(other), address(router), ONE_USDG, 1);
    }

    function test_revert_buy_tokenApprovalRevoked() public {
        vm.prank(owner);
        vault.setTokenApproval(address(stock), address(feed), false);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.TokenNotApproved.selector, address(stock)));
    }

    function test_revert_buy_missingPriceFeed() public {
        // The setter refuses approval without a feed, so use the harness to prove the trade-time check holds too.
        GlanceVaultHarness h = new GlanceVaultHarness(owner, address(usdg));
        vm.prank(owner);
        h.setAgent(agent, uint64(block.timestamp) + AGENT_TTL);
        h.forceApproveWithoutFeed(address(stock));
        (bool approved, address priceFeed,,) = h.tokenConfig(address(stock));
        assertTrue(approved);
        assertEq(priceFeed, address(0));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.MissingPriceFeed.selector, address(stock)));
        h.buy(address(stock), address(router), ONE_USDG, 0);
    }

    function test_revert_buy_unapprovedRouter() public {
        vm.prank(owner);
        vault.setRouterApproval(address(router), false);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.RouterNotApproved.selector, address(router)));
    }

    function test_revert_buy_expiredAgent() public {
        uint64 expiry = vault.agentExpiry();
        vm.warp(expiry);
        feed.setUpdatedAt(block.timestamp);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.AgentExpired.selector, expiry));
    }

    function test_revert_buy_revokedAgent() public {
        vm.prank(owner);
        vault.revokeAgent();
        assertFalse(vault.isActiveAgent(agent));
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.NotAgent.selector, agent));
    }

    function test_revert_buy_notAgent() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.NotAgent.selector, attacker));
        vault.buy(address(stock), address(router), ONE_USDG, 0);
    }

    function test_revert_buy_paused() public {
        vm.prank(owner);
        vault.setPaused(true);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.VaultPaused.selector));
    }

    function test_revert_buy_staleOracle() public {
        uint256 age = MarketStatusLib.DEFAULT_CLOSED_MAX_AGE + 1;
        _setFeedAge(age);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.OracleStale.selector, block.timestamp - age));
    }

    function test_revert_buy_nonPositiveOraclePrice() public {
        feed.setPrice(0);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(MarketStatusLib.InvalidOraclePrice.selector, int256(0)));
        feed.setPrice(-1);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(MarketStatusLib.InvalidOraclePrice.selector, int256(-1)));
    }

    function test_revert_buy_minOutWorseThanOracleBound() public {
        uint256 amount = 100 * ONE_USDG;
        uint256 floor = _quote(amount) * (10_000 - SLIPPAGE_BPS) / 10_000;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.SlippageTooHigh.selector, floor - 1, floor));
        vault.buy(address(stock), address(router), amount, floor - 1);
    }

    function test_revert_buy_routerReturnsLessThanMinOut() public {
        router.setShortchange(true);
        uint256 amount = 100 * ONE_USDG;
        uint256 minOut = _quote(amount);
        _expectBuyRevert(amount, abi.encodeWithSelector(GlanceVault.InsufficientOutput.selector, minOut - 1, minOut));
        assertEq(vault.spentInWindow(), 0, "failed trade leaves no spend behind");
    }

    function test_revert_buy_zeroAmount() public {
        _expectBuyRevert(0, abi.encodeWithSelector(GlanceVault.ZeroAmount.selector));
    }

    function test_revert_buy_insufficientBalance() public {
        vm.prank(owner);
        vault.withdraw(address(usdg), DEPOSIT - 10 * ONE_USDG);
        _expectBuyRevert(
            50 * ONE_USDG,
            abi.encodeWithSelector(GlanceVault.InsufficientBalance.selector, 10 * ONE_USDG, 50 * ONE_USDG)
        );
    }

    /// @dev With several violations at once, the first check in the documented order is the one reported.
    function test_checkOrder_isPauseAgentTokenRouterOracleCaps() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        address badRouter = makeAddr("badRouter");
        _setFeedAge(MarketStatusLib.DEFAULT_CLOSED_MAX_AGE + 1);
        vm.prank(owner);
        vault.setPaused(true);

        vm.prank(attacker);
        vm.expectRevert(GlanceVault.VaultPaused.selector);
        vault.buy(address(other), badRouter, PER_BUY_CAP * 10, 0);

        vm.prank(owner);
        vault.setPaused(false);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.NotAgent.selector, attacker));
        vault.buy(address(other), badRouter, PER_BUY_CAP * 10, 0);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.TokenNotApproved.selector, address(other)));
        vault.buy(address(other), badRouter, PER_BUY_CAP * 10, 0);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.RouterNotApproved.selector, badRouter));
        vault.buy(address(stock), badRouter, PER_BUY_CAP * 10, 0);

        uint256 staleAt = feed.updatedAt();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.OracleStale.selector, staleAt));
        vault.buy(address(stock), address(router), PER_BUY_CAP * 10, 0);

        feed.setUpdatedAt(block.timestamp);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, PER_BUY_CAP * 10, PER_BUY_CAP));
        vault.buy(address(stock), address(router), PER_BUY_CAP * 10, 0);
    }

    // ---------------------------------------------------------------------
    // Weekend (market closed) behaviour
    // ---------------------------------------------------------------------

    function test_weekend_sameBuyRevertsOverReducedCap_smallerBuySucceeds() public {
        uint256 amount = 100 * ONE_USDG;
        uint256 closedPerTrade = PER_BUY_CAP * WEEKEND_CAP_BPS / 10_000; // 25 USDG
        uint256 closedDaily = DAILY_CAP * WEEKEND_CAP_BPS / 10_000; // 125 USDG

        // Weekday: the buy passes.
        uint256 snap = vm.snapshotState();
        _buy(amount);
        vm.revertToState(snap);

        // Weekend: last price 30 hours ago -> CLOSED.
        _setFeedAge(30 hours);
        _expectBuyRevert(
            amount, abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, amount, closedPerTrade)
        );

        uint256 small = 20 * ONE_USDG;
        vm.expectEmit(address(vault));
        emit GlanceVault.Bought(
            address(stock),
            address(router),
            small,
            _quote(small),
            uint256(PRICE),
            MarketStatusLib.MarketState.CLOSED,
            closedPerTrade,
            closedDaily
        );
        _buy(small);
        assertEq(stock.balanceOf(address(vault)), _quote(small));
    }

    function test_weekend_dailyCapReducedAndIncludesWeekdaySpend() public {
        _buy(100 * ONE_USDG); // weekday spend
        _setFeedAge(30 hours); // market now closed; closed daily cap is 125 USDG

        _buy(20 * ONE_USDG); // 120 total
        uint256 closedDaily = DAILY_CAP * WEEKEND_CAP_BPS / 10_000;
        _expectBuyRevert(
            10 * ONE_USDG,
            abi.encodeWithSelector(GlanceVault.ExceedsDailyCap.selector, 120 * ONE_USDG, 10 * ONE_USDG, closedDaily)
        );
    }

    function test_weekend_slippageTightened() public {
        uint256 amount = 20 * ONE_USDG;
        // 0.9% below oracle: inside the 1% open allowance, outside the 0.5% closed allowance.
        uint256 minOut = _quote(amount) * 9_910 / 10_000;
        router.setOutputBps(9_910);

        uint256 snap = vm.snapshotState();
        vm.prank(agent);
        vault.buy(address(stock), address(router), amount, minOut);
        vm.revertToState(snap);

        _setFeedAge(30 hours);
        uint256 closedFloor = _quote(amount) * (10_000 - SLIPPAGE_BPS / 2) / 10_000;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.SlippageTooHigh.selector, minOut, closedFloor));
        vault.buy(address(stock), address(router), amount, minOut);
    }

    function test_marketState_boundaries() public {
        (uint256 openTrade,,) = vault.effectiveCaps(MarketStatusLib.MarketState.OPEN);
        (uint256 closedTrade,,) = vault.effectiveCaps(MarketStatusLib.MarketState.CLOSED);

        _setFeedAge(1 hours); // still OPEN
        _buy(openTrade);

        _setFeedAge(1 hours + 1); // CLOSED
        _expectBuyRevert(
            openTrade, abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, openTrade, closedTrade)
        );

        _setFeedAge(80 hours); // still CLOSED
        _buy(closedTrade);
    }

    // ---------------------------------------------------------------------
    // Rolling 24h window
    // ---------------------------------------------------------------------

    function test_rollingWindow_recoversAfter25Hours() public {
        for (uint256 i; i < 5; ++i) {
            _buy(PER_BUY_CAP);
            _skipAndRefresh(1 hours);
        }
        _expectBuyRevert(
            PER_BUY_CAP, abi.encodeWithSelector(GlanceVault.ExceedsDailyCap.selector, DAILY_CAP, PER_BUY_CAP, DAILY_CAP)
        );

        _skipAndRefresh(25 hours);
        assertEq(vault.spentInWindow(), 0);
        _buy(PER_BUY_CAP);
        assertEq(vault.spentInWindow(), PER_BUY_CAP);
    }

    function test_rollingWindow_exactBoundary() public {
        uint256 t0 = block.timestamp;
        for (uint256 i; i < 5; ++i) {
            _buy(PER_BUY_CAP);
        }

        vm.warp(t0 + RollingSpendLib.WINDOW - 1);
        feed.setUpdatedAt(block.timestamp);
        _expectBuyRevert(1, abi.encodeWithSelector(GlanceVault.ExceedsDailyCap.selector, DAILY_CAP, 1, DAILY_CAP));

        vm.warp(t0 + RollingSpendLib.WINDOW);
        feed.setUpdatedAt(block.timestamp);
        _buy(PER_BUY_CAP);
    }

    function test_rollingWindow_partialExpiry() public {
        _buy(PER_BUY_CAP); // t = 0
        _skipAndRefresh(12 hours);
        for (uint256 i; i < 4; ++i) {
            _buy(PER_BUY_CAP); // t = 12h, total 500
        }
        _skipAndRefresh(12 hours); // t = 24h: first 100 expires
        assertEq(vault.spentInWindow(), 4 * PER_BUY_CAP);
        _buy(PER_BUY_CAP);
        _expectBuyRevert(1, abi.encodeWithSelector(GlanceVault.ExceedsDailyCap.selector, DAILY_CAP, 1, DAILY_CAP));
    }

    function test_rollingWindow_bufferFullReverts() public {
        uint256 t0 = block.timestamp;
        uint256 capacity = RollingSpendLib.CAPACITY;
        for (uint256 i; i < capacity; ++i) {
            _buy(ONE_USDG);
            _skipAndRefresh(1 minutes);
        }
        _expectBuyRevert(
            ONE_USDG, abi.encodeWithSelector(RollingSpendLib.SpendBufferFull.selector, t0 + RollingSpendLib.WINDOW)
        );

        // Once the oldest entry ages out a slot frees up.
        vm.warp(t0 + RollingSpendLib.WINDOW);
        feed.setUpdatedAt(block.timestamp);
        _buy(ONE_USDG);
    }

    function test_rollingWindow_sameBlockBuysShareASlot() public {
        uint256 capacity = RollingSpendLib.CAPACITY;
        for (uint256 i; i < capacity - 1; ++i) {
            _buy(ONE_USDG);
            _skipAndRefresh(1 minutes);
        }
        // The last slot can absorb any number of buys in the same block.
        for (uint256 i; i < 10; ++i) {
            _buy(ONE_USDG);
        }
        assertEq(vault.spentInWindow(), (capacity - 1 + 10) * ONE_USDG);
    }

    // ---------------------------------------------------------------------
    // Sell
    // ---------------------------------------------------------------------

    function test_sell_withinLimits_movesBalances() public {
        uint256 tokens = _buy(100 * ONE_USDG);
        _skipAndRefresh(25 hours);

        vm.expectEmit(address(vault));
        emit GlanceVault.Sold(
            address(stock),
            address(router),
            tokens,
            100 * ONE_USDG,
            100 * ONE_USDG,
            uint256(PRICE),
            MarketStatusLib.MarketState.OPEN,
            PER_BUY_CAP,
            DAILY_SELL_CAP
        );
        vm.prank(agent);
        uint256 out = vault.sell(address(stock), address(router), tokens, 100 * ONE_USDG);

        assertEq(out, 100 * ONE_USDG);
        assertEq(stock.balanceOf(address(vault)), 0);
        assertEq(usdg.balanceOf(address(vault)), DEPOSIT);
        assertEq(vault.spentInWindow(), 0, "buy window has rolled over");
        assertEq(vault.soldInWindow(), 100 * ONE_USDG, "sell notional counts toward the sell window");
    }

    function test_revert_sell_minOutWorseThanOracleBound() public {
        uint256 tokens = _buy(100 * ONE_USDG);
        uint256 floor = 100 * ONE_USDG * (10_000 - SLIPPAGE_BPS) / 10_000;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.SlippageTooHigh.selector, floor - 1, floor));
        vault.sell(address(stock), address(router), tokens, floor - 1);
    }

    function test_revert_sell_routerReturnsLessThanMinOut() public {
        uint256 tokens = _buy(100 * ONE_USDG);
        router.setShortchange(true);
        uint256 minOut = 100 * ONE_USDG;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.InsufficientOutput.selector, minOut - 1, minOut));
        vault.sell(address(stock), address(router), tokens, minOut);
    }

    function test_revert_sell_overPerTradeCap() public {
        stock.mint(address(vault), 1e18); // $200 of stock
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, 200 * ONE_USDG, PER_BUY_CAP));
        vault.sell(address(stock), address(router), 1e18, 0);
    }

    function test_revert_sell_notAgent() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.NotAgent.selector, attacker));
        vault.sell(address(stock), address(router), 1, 0);
    }

    // ---------------------------------------------------------------------
    // Per-token oracle freshness
    // ---------------------------------------------------------------------

    /// @dev Thresholds for a Chainlink-style feed with a 24h heartbeat: OPEN up to 26h, CLOSED up to 96h.
    uint32 internal constant HB24_OPEN = 26 hours;
    uint32 internal constant HB24_CLOSED = 96 hours;

    function test_freshness_defaultsSetOnApproval() public view {
        (,, uint32 openMaxAge, uint32 closedMaxAge) = vault.tokenConfig(address(stock));
        assertEq(openMaxAge, MarketStatusLib.DEFAULT_OPEN_MAX_AGE);
        assertEq(closedMaxAge, MarketStatusLib.DEFAULT_CLOSED_MAX_AGE);
        assertEq(openMaxAge, 3600);
        assertEq(closedMaxAge, 288_000);
    }

    function test_freshness_defaultsBehaveAsBefore() public {
        // 20h old with the defaults: CLOSED, so a full-size buy is over the 25% cap.
        _setFeedAge(20 hours);
        _expectBuyRevert(
            PER_BUY_CAP, abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, PER_BUY_CAP, PER_BUY_CAP / 4)
        );
    }

    function test_freshness_24hHeartbeatConfigReadsOpenAt20Hours() public {
        vm.expectEmit(address(vault));
        emit GlanceVault.TokenFreshnessSet(address(stock), HB24_OPEN, HB24_CLOSED);
        vm.prank(owner);
        vault.setTokenFreshness(address(stock), HB24_OPEN, HB24_CLOSED);

        _setFeedAge(20 hours);
        vm.expectEmit(address(vault));
        emit GlanceVault.Bought(
            address(stock),
            address(router),
            PER_BUY_CAP,
            _quote(PER_BUY_CAP),
            uint256(PRICE),
            MarketStatusLib.MarketState.OPEN,
            PER_BUY_CAP,
            DAILY_CAP
        );
        _buy(PER_BUY_CAP);
    }

    function test_freshness_24hHeartbeatConfigClosedAndStaleBoundaries() public {
        vm.prank(owner);
        vault.setTokenFreshness(address(stock), HB24_OPEN, HB24_CLOSED);

        _setFeedAge(uint256(HB24_OPEN) + 1); // CLOSED
        _expectBuyRevert(
            PER_BUY_CAP, abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, PER_BUY_CAP, PER_BUY_CAP / 4)
        );

        _setFeedAge(90 hours); // STALE under the defaults, still CLOSED here
        _buy(PER_BUY_CAP / 4);

        uint256 staleAt = block.timestamp - HB24_CLOSED - 1;
        feed.setUpdatedAt(staleAt);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.OracleStale.selector, staleAt));
    }

    function test_freshness_tighterClosedMaxAgeMakesFeedStaleSooner() public {
        vm.prank(owner);
        vault.setTokenFreshness(address(stock), 30 minutes, 2 hours);
        _setFeedAge(45 minutes); // CLOSED under a 30 minute openMaxAge
        _buy(PER_BUY_CAP / 4);
        uint256 staleAt = block.timestamp - 3 hours;
        feed.setUpdatedAt(staleAt);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.OracleStale.selector, staleAt));
    }

    function test_freshness_perTokenChangeDoesNotAffectOtherTokens() public {
        MockERC20 other = new MockERC20("Other tokenized", "OTHx", 18);
        MockPriceFeed otherFeed = new MockPriceFeed(FEED_DECIMALS, PRICE);
        vm.startPrank(owner);
        vault.setTokenApproval(address(other), address(otherFeed), true);
        vault.setTokenFreshness(address(stock), HB24_OPEN, HB24_CLOSED);
        vm.stopPrank();

        (,, uint32 otherOpen, uint32 otherClosed) = vault.tokenConfig(address(other));
        assertEq(otherOpen, MarketStatusLib.DEFAULT_OPEN_MAX_AGE);
        assertEq(otherClosed, MarketStatusLib.DEFAULT_CLOSED_MAX_AGE);

        _setFeedAge(20 hours);
        otherFeed.setUpdatedAt(block.timestamp - 20 hours);

        _buy(PER_BUY_CAP); // stock: OPEN under its 24h-heartbeat thresholds
        uint256 minOut = _quote(PER_BUY_CAP); // same price and decimals as `stock`
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, PER_BUY_CAP, PER_BUY_CAP / 4));
        vault.buy(address(other), address(router), PER_BUY_CAP, minOut); // other: CLOSED under the defaults
    }

    function test_freshness_survivesReapproval() public {
        vm.startPrank(owner);
        vault.setTokenFreshness(address(stock), HB24_OPEN, HB24_CLOSED);
        vault.setTokenApproval(address(stock), address(feed), false);
        vault.setTokenApproval(address(stock), address(feed), true);
        vm.stopPrank();
        (,, uint32 openMaxAge, uint32 closedMaxAge) = vault.tokenConfig(address(stock));
        assertEq(openMaxAge, HB24_OPEN);
        assertEq(closedMaxAge, HB24_CLOSED);
    }

    function test_freshness_canBeSetBeforeApproval() public {
        MockERC20 other = new MockERC20("Other tokenized", "OTHx", 18);
        vm.startPrank(owner);
        vault.setTokenFreshness(address(other), HB24_OPEN, HB24_CLOSED);
        vault.setTokenApproval(address(other), address(feed), true);
        vm.stopPrank();
        (bool approved,, uint32 openMaxAge,) = vault.tokenConfig(address(other));
        assertTrue(approved);
        assertEq(openMaxAge, HB24_OPEN, "approval keeps thresholds set earlier");
    }

    function test_freshness_validation() public {
        uint32 maxAge = vault.MAX_FRESHNESS_AGE();
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.InvalidFreshness.selector, 0, 1 hours));
        vault.setTokenFreshness(address(stock), 0, 1 hours);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.InvalidFreshness.selector, 2 hours, 2 hours));
        vault.setTokenFreshness(address(stock), 2 hours, 2 hours);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.InvalidFreshness.selector, 3 hours, 2 hours));
        vault.setTokenFreshness(address(stock), 3 hours, 2 hours);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.InvalidFreshness.selector, 1 hours, maxAge + 1));
        vault.setTokenFreshness(address(stock), 1 hours, maxAge + 1);
        vm.expectRevert(GlanceVault.ZeroAddress.selector);
        vault.setTokenFreshness(address(0), 1 hours, 2 hours);
        vm.expectRevert(GlanceVault.InvalidTokenConfig.selector);
        vault.setTokenFreshness(address(usdg), 1 hours, 2 hours);
        vault.setTokenFreshness(address(stock), maxAge - 1, maxAge); // the bound itself is allowed
        vm.stopPrank();
    }

    function test_revert_freshness_nonOwner() public {
        vm.prank(agent);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.setTokenFreshness(address(stock), 1 hours, 2 hours);
    }

    // ---------------------------------------------------------------------
    // Separate buy and sell windows
    // ---------------------------------------------------------------------

    /// @dev Sells `usdgValue` worth of stock (at the oracle price) that the vault already holds.
    function _sell(uint256 usdgValue) internal returns (uint256) {
        uint256 tokens = _quote(usdgValue);
        vm.prank(agent);
        return vault.sell(address(stock), address(router), tokens, usdgValue);
    }

    function _expectSellRevert(uint256 usdgValue, bytes memory err) internal {
        uint256 tokens = _quote(usdgValue);
        vm.prank(agent);
        vm.expectRevert(err);
        vault.sell(address(stock), address(router), tokens, usdgValue);
    }

    function test_exhaustedBuyCap_doesNotBlockSell() public {
        for (uint256 i; i < 5; ++i) {
            _buy(PER_BUY_CAP);
        }
        _expectBuyRevert(1, abi.encodeWithSelector(GlanceVault.ExceedsDailyCap.selector, DAILY_CAP, 1, DAILY_CAP));

        uint256 out = _sell(PER_BUY_CAP);
        assertEq(out, PER_BUY_CAP);
        assertEq(vault.spentInWindow(), DAILY_CAP, "sell does not touch the buy window");
        assertEq(vault.soldInWindow(), PER_BUY_CAP);
    }

    function test_sellCap_enforcedIndependently() public {
        uint256 sellCap = 150 * ONE_USDG;
        vm.prank(owner);
        vault.setLimits(PER_BUY_CAP, DAILY_CAP, sellCap, SLIPPAGE_BPS, WEEKEND_CAP_BPS);
        stock.mint(address(vault), 10e18);

        _sell(PER_BUY_CAP);
        _sell(50 * ONE_USDG); // exactly at the sell cap
        _expectSellRevert(
            ONE_USDG, abi.encodeWithSelector(GlanceVault.ExceedsDailySellCap.selector, sellCap, ONE_USDG, sellCap)
        );

        // Buys are still limited only by the buy cap.
        for (uint256 i; i < 5; ++i) {
            _buy(PER_BUY_CAP);
        }
        assertEq(vault.spentInWindow(), DAILY_CAP);
        assertEq(vault.soldInWindow(), sellCap);
    }

    function test_sellsDoNotConsumeBuyBudget() public {
        stock.mint(address(vault), 10e18);
        for (uint256 i; i < 5; ++i) {
            _sell(PER_BUY_CAP);
        }
        for (uint256 i; i < 5; ++i) {
            _buy(PER_BUY_CAP);
        }
        assertEq(vault.spentInWindow(), DAILY_CAP);
        assertEq(vault.soldInWindow(), DAILY_SELL_CAP);
    }

    function test_buyAndSellWindowsRollIndependently() public {
        stock.mint(address(vault), 10e18);
        uint256 t0 = block.timestamp;

        // Fill the buy window at t0 and the sell window at t0 + 12h.
        for (uint256 i; i < 5; ++i) {
            _buy(PER_BUY_CAP);
        }
        _skipAndRefresh(12 hours);
        for (uint256 i; i < 5; ++i) {
            _sell(PER_BUY_CAP);
        }

        // At t0 + 24h the buy window has rolled over but the sell window has not.
        vm.warp(t0 + 24 hours);
        feed.setUpdatedAt(block.timestamp);
        assertEq(vault.spentInWindow(), 0);
        assertEq(vault.soldInWindow(), DAILY_SELL_CAP);
        _buy(PER_BUY_CAP);
        _expectSellRevert(
            ONE_USDG,
            abi.encodeWithSelector(GlanceVault.ExceedsDailySellCap.selector, DAILY_SELL_CAP, ONE_USDG, DAILY_SELL_CAP)
        );

        // At t0 + 36h the sell window has rolled over too.
        vm.warp(t0 + 36 hours);
        feed.setUpdatedAt(block.timestamp);
        assertEq(vault.soldInWindow(), 0);
        assertEq(vault.spentInWindow(), PER_BUY_CAP);
        _sell(PER_BUY_CAP);
    }

    function test_weekend_reducesSellCaps() public {
        stock.mint(address(vault), 10e18);
        _setFeedAge(30 hours);
        (uint256 closedTrade,, uint256 closedSellDaily) = vault.effectiveCaps(MarketStatusLib.MarketState.CLOSED);
        assertEq(closedTrade, 25 * ONE_USDG);
        assertEq(closedSellDaily, 125 * ONE_USDG);

        _expectSellRevert(
            PER_BUY_CAP, abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, PER_BUY_CAP, closedTrade)
        );
        for (uint256 i; i < 5; ++i) {
            _sell(closedTrade);
        }
        _expectSellRevert(
            ONE_USDG,
            abi.encodeWithSelector(GlanceVault.ExceedsDailySellCap.selector, closedSellDaily, ONE_USDG, closedSellDaily)
        );
    }

    function test_revert_sell_paused() public {
        stock.mint(address(vault), 1e18);
        vm.prank(owner);
        vault.setPaused(true);
        _expectSellRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.VaultPaused.selector));
    }

    function test_revert_sell_staleOracle() public {
        stock.mint(address(vault), 1e18);
        _setFeedAge(MarketStatusLib.DEFAULT_CLOSED_MAX_AGE + 1);
        _expectSellRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.OracleStale.selector, feed.updatedAt()));
    }

    function test_revert_sell_unapprovedTokenAndRouter() public {
        stock.mint(address(vault), 1e18);
        vm.prank(owner);
        vault.setRouterApproval(address(router), false);
        _expectSellRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.RouterNotApproved.selector, address(router)));

        vm.prank(owner);
        vault.setTokenApproval(address(stock), address(feed), false);
        _expectSellRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.TokenNotApproved.selector, address(stock)));
    }

    function test_revert_sell_expiredAgent() public {
        stock.mint(address(vault), 1e18);
        uint64 expiry = vault.agentExpiry();
        vm.warp(expiry);
        feed.setUpdatedAt(block.timestamp);
        _expectSellRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.AgentExpired.selector, expiry));
    }

    // ---------------------------------------------------------------------
    // L2 sequencer uptime
    // ---------------------------------------------------------------------

    function _installSequencerFeed() internal returns (MockSequencerUptimeFeed seq) {
        seq = new MockSequencerUptimeFeed();
        vm.expectEmit(address(vault));
        emit GlanceVault.SequencerUptimeFeedSet(address(seq));
        vm.prank(owner);
        vault.setSequencerUptimeFeed(address(seq));
    }

    function test_sequencer_disabledByDefault() public {
        assertEq(address(vault.sequencerUptimeFeed()), address(0));
        _buy(ONE_USDG);
    }

    function test_revert_sequencer_down() public {
        MockSequencerUptimeFeed seq = _installSequencerFeed();
        seq.setStatus(true, block.timestamp - 2 hours);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.SequencerDown.selector));
        stock.mint(address(vault), 1e18);
        _expectSellRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.SequencerDown.selector));
    }

    function test_revert_sequencer_uninitialised() public {
        MockSequencerUptimeFeed seq = _installSequencerFeed();
        seq.setStatus(false, 0);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.SequencerDown.selector));
    }

    function test_revert_sequencer_insideGracePeriod() public {
        MockSequencerUptimeFeed seq = _installSequencerFeed();
        uint256 upAt = block.timestamp - 10 minutes;
        seq.setStatus(false, upAt);
        uint256 trustedFrom = upAt + vault.SEQUENCER_GRACE_PERIOD();
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.SequencerGracePeriod.selector, trustedFrom));

        // One second before the grace period ends it still reverts.
        vm.warp(trustedFrom - 1);
        feed.setUpdatedAt(block.timestamp);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.SequencerGracePeriod.selector, trustedFrom));
    }

    function test_sequencer_passesAfterGracePeriod() public {
        MockSequencerUptimeFeed seq = _installSequencerFeed();
        uint256 upAt = block.timestamp;
        seq.setStatus(false, upAt);

        vm.warp(upAt + vault.SEQUENCER_GRACE_PERIOD());
        feed.setUpdatedAt(block.timestamp);
        _buy(ONE_USDG);
    }

    function test_sequencer_ownerCanSetAndUnset() public {
        MockSequencerUptimeFeed seq = _installSequencerFeed();
        assertEq(address(vault.sequencerUptimeFeed()), address(seq));
        seq.setStatus(true, block.timestamp);
        _expectBuyRevert(ONE_USDG, abi.encodeWithSelector(GlanceVault.SequencerDown.selector));

        vm.expectEmit(address(vault));
        emit GlanceVault.SequencerUptimeFeedSet(address(0));
        vm.prank(owner);
        vault.setSequencerUptimeFeed(address(0));
        assertEq(address(vault.sequencerUptimeFeed()), address(0));
        _buy(ONE_USDG);
    }

    function test_revert_sequencer_setByNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.setSequencerUptimeFeed(address(1));
    }

    // ---------------------------------------------------------------------
    // Owner configuration validation
    // ---------------------------------------------------------------------

    function test_setAgent_validation() public {
        uint64 tooFar = uint64(block.timestamp + vault.MAX_AGENT_TTL() + 1);
        vm.startPrank(owner);
        vm.expectRevert(GlanceVault.ZeroAddress.selector);
        vault.setAgent(address(0), uint64(block.timestamp + 1));

        uint64 past = uint64(block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.InvalidAgentExpiry.selector, past));
        vault.setAgent(agent, past);

        vm.expectRevert(abi.encodeWithSelector(GlanceVault.InvalidAgentExpiry.selector, tooFar));
        vault.setAgent(agent, tooFar);
        vm.stopPrank();
    }

    function test_setLimits_validation() public {
        uint16 maxSlippage = vault.MAX_SLIPPAGE_BPS();
        vm.startPrank(owner);
        vm.expectRevert(GlanceVault.InvalidLimits.selector);
        vault.setLimits(0, DAILY_CAP, DAILY_SELL_CAP, SLIPPAGE_BPS, WEEKEND_CAP_BPS);
        vm.expectRevert(GlanceVault.InvalidLimits.selector);
        vault.setLimits(DAILY_CAP + 1, DAILY_CAP, DAILY_CAP + 1, SLIPPAGE_BPS, WEEKEND_CAP_BPS);
        vm.expectRevert(GlanceVault.InvalidLimits.selector);
        vault.setLimits(PER_BUY_CAP, DAILY_CAP, PER_BUY_CAP - 1, SLIPPAGE_BPS, WEEKEND_CAP_BPS);
        vm.expectRevert(GlanceVault.InvalidLimits.selector);
        vault.setLimits(PER_BUY_CAP, DAILY_CAP, DAILY_SELL_CAP, maxSlippage + 1, WEEKEND_CAP_BPS);
        vm.expectRevert(GlanceVault.InvalidLimits.selector);
        vault.setLimits(PER_BUY_CAP, DAILY_CAP, DAILY_SELL_CAP, SLIPPAGE_BPS, 10_001);
        vm.stopPrank();
    }

    function test_setTokenApproval_validation() public {
        vm.startPrank(owner);
        vm.expectRevert(GlanceVault.InvalidTokenConfig.selector);
        vault.setTokenApproval(address(usdg), address(feed), true);
        vm.expectRevert(GlanceVault.InvalidTokenConfig.selector);
        vault.setTokenApproval(address(stock), address(0), true);
        vm.expectRevert(GlanceVault.ZeroAddress.selector);
        vault.setTokenApproval(address(0), address(feed), true);
        vm.stopPrank();
    }

    function test_weekendCapZero_blocksAllClosedMarketTrading() public {
        vm.prank(owner);
        vault.setLimits(PER_BUY_CAP, DAILY_CAP, DAILY_SELL_CAP, SLIPPAGE_BPS, 0);
        _setFeedAge(30 hours);
        _expectBuyRevert(1, abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, 1, 0));
    }

    // ---------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------

    /// @dev Any single buy is bounded by the per-trade cap.
    function testFuzz_buyNeverExceedsPerTradeCap(uint256 amount) public {
        amount = bound(amount, 1, DEPOSIT);
        if (amount > PER_BUY_CAP) {
            _expectBuyRevert(
                amount, abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, amount, PER_BUY_CAP)
            );
        } else {
            _buy(amount);
        }
    }

    /// @dev The slippage floor accepts exactly the minOuts at or above oracle * (1 - maxSlippage).
    function testFuzz_slippageFloor(uint256 amount, uint256 minOut) public {
        amount = bound(amount, 1, PER_BUY_CAP);
        uint256 expected = _quote(amount);
        minOut = bound(minOut, 0, expected);
        uint256 floor = expected * (10_000 - SLIPPAGE_BPS) / 10_000;

        vm.prank(agent);
        if (minOut < floor) {
            vm.expectRevert(abi.encodeWithSelector(GlanceVault.SlippageTooHigh.selector, minOut, floor));
        }
        vault.buy(address(stock), address(router), amount, minOut);
    }

    /// @dev Random sequences of buys and time jumps. After every attempt the vault must agree exactly with a
    ///      brute-force model, and no 24h window of successful buys may exceed the daily cap.
    function testFuzz_rollingWindowNeverExceedsCap(uint256 seed) public {
        uint256 steps = 60;
        uint256[] memory times = new uint256[](steps);
        uint256[] memory amounts = new uint256[](steps);
        uint256 n;

        for (uint256 i; i < steps; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            // Mix of same-block, minutes, hours and multi-day jumps to hit merge, prune and wrap paths.
            uint256 mode = r % 4;
            uint256 dt =
                mode == 0 ? 0 : mode == 1 ? (r >> 8) % 1 hours : mode == 2 ? (r >> 8) % 12 hours : (r >> 8) % 30 hours;
            _skipAndRefresh(dt);
            // Keep the agent key alive across multi-week sequences.
            vm.prank(owner);
            vault.setAgent(agent, uint64(block.timestamp) + AGENT_TTL);
            uint256 amount = bound(r >> 128, 1, PER_BUY_CAP);

            (uint256 inWindow, uint256 slots, bool lastIsNow) = _model(times, amounts, n, block.timestamp);
            bool fits = inWindow + amount <= DAILY_CAP;
            bool hasSlot = lastIsNow || slots < RollingSpendLib.CAPACITY;
            assertEq(vault.spentInWindow(), inWindow, "window total matches model");

            vm.prank(agent);
            try vault.buy(address(stock), address(router), amount, _quote(amount)) {
                assertTrue(fits && hasSlot, "vault accepted a buy the model rejects");
                times[n] = block.timestamp;
                amounts[n] = amount;
                ++n;
            } catch (bytes memory err) {
                assertFalse(fits && hasSlot, "vault rejected a buy the model accepts");
                bytes4 sel = bytes4(err);
                assertTrue(
                    sel == GlanceVault.ExceedsDailyCap.selector || sel == RollingSpendLib.SpendBufferFull.selector,
                    "unexpected revert"
                );
            }
        }

        // Every 24h window ending at a successful buy stays within the cap. The maximum over all windows is
        // attained at a window ending at some buy, so this covers every window.
        for (uint256 i; i < n; ++i) {
            uint256 sum;
            for (uint256 j; j < n; ++j) {
                if (times[j] <= times[i] && times[j] + RollingSpendLib.WINDOW > times[i]) sum += amounts[j];
            }
            assertLe(sum, DAILY_CAP, "24h window exceeded cap");
        }
    }

    /// @dev Brute-force window model: spend in window, distinct timestamps in window, and whether the newest
    ///      in-window buy happened at `nowTs`.
    function _model(uint256[] memory times, uint256[] memory amounts, uint256 n, uint256 nowTs)
        internal
        pure
        returns (uint256 sum, uint256 distinct, bool lastIsNow)
    {
        uint256 prevTs = type(uint256).max;
        for (uint256 i; i < n; ++i) {
            if (times[i] + RollingSpendLib.WINDOW > nowTs) {
                sum += amounts[i];
                if (times[i] != prevTs) ++distinct;
                prevTs = times[i];
            }
        }
        lastIsNow = n != 0 && times[n - 1] == nowTs;
    }
}
