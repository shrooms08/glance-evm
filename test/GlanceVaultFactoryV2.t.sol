// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ConfiguredGlanceVault, TokenInit, VaultConfig} from "../src/ConfiguredGlanceVault.sol";
import {GlanceVault} from "../src/GlanceVault.sol";
import {GlanceVaultFactory} from "../src/GlanceVaultFactory.sol";
import {GlanceVaultFactoryV2} from "../src/GlanceVaultFactoryV2.sol";
import {MarketStatusLib} from "../src/MarketStatusLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPriceFeed} from "./mocks/MockPriceFeed.sol";
import {MockRouter} from "./mocks/MockRouter.sol";
import {MockSequencerUptimeFeed} from "./mocks/MockSequencerUptimeFeed.sol";

/// @dev transferFrom reports failure without reverting (an old-style token).
contract FalseToken is MockERC20 {
    constructor() MockERC20("False", "FALSE", 6) {}

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// @dev Keeps 1% of every transferFrom: the vault must notice the deposit didn't fully arrive.
contract FeeToken is MockERC20 {
    constructor() MockERC20("Fee", "FEE", 6) {}

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount - amount / 100);
        _burn(from, amount / 100);
        return true;
    }
}

/// @dev Calls back into the factory from inside transferFrom.
contract ReentrantToken is MockERC20 {
    address internal target;
    bytes internal payload;

    constructor() MockERC20("Reentrant", "RE", 6) {}

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (target != address(0)) {
            address t = target;
            target = address(0);
            (bool ok, bytes memory ret) = t.call(payload);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
        return super.transferFrom(from, to, amount);
    }
}

contract GlanceVaultFactoryV2Test is Test {
    uint256 internal constant START = 1_750_000_000;
    uint256 internal constant ONE = 1e6;
    int256 internal constant PRICE = 200e8;

    address internal alice = makeAddr("alice"); // one transaction
    address internal bob = makeAddr("bob"); // step by step, the old way
    address internal agent = makeAddr("agent");

    MockERC20 internal usdg;
    MockERC20 internal stockA;
    MockERC20 internal stockB;
    MockPriceFeed internal feedA;
    MockPriceFeed internal feedB;
    MockRouter internal router;
    MockSequencerUptimeFeed internal sequencer;
    GlanceVaultFactory internal v1;
    GlanceVaultFactoryV2 internal v2;

    function setUp() public {
        vm.warp(START);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        stockA = new MockERC20("Tesla", "TSLA", 18);
        stockB = new MockERC20("Amazon", "AMZN", 18);
        feedA = new MockPriceFeed(8, PRICE);
        feedB = new MockPriceFeed(8, PRICE);
        router = new MockRouter(usdg, uint256(PRICE));
        sequencer = new MockSequencerUptimeFeed();
        v1 = new GlanceVaultFactory();
        v2 = new GlanceVaultFactoryV2();
        usdg.mint(alice, 1_000 * ONE);
        usdg.mint(bob, 1_000 * ONE);
    }

    /// @dev Non-default values everywhere, so nothing passes by coincidence with the constructor defaults.
    function _config() internal view returns (VaultConfig memory c) {
        c.usdg = address(usdg);
        c.agent = agent;
        c.agentExpiry = uint64(block.timestamp + 30 days);
        c.tokens = new TokenInit[](2);
        c.tokens[0] = TokenInit(address(stockA), address(feedA), 72_000, 345_600);
        c.tokens[1] = TokenInit(address(stockB), address(feedB), 0, 0); // keeps setTokenApproval's defaults
        c.routers = new address[](1);
        c.routers[0] = address(router);
        c.perBuyCap = 80 * ONE;
        c.dailyCap = 300 * ONE;
        c.dailySellCap = 250 * ONE;
        c.maxSlippageBps = 75;
        c.weekendCapBps = 3_000;
        c.sequencerUptimeFeed = address(sequencer);
    }

    function _oneTx(address who, VaultConfig memory c, uint256 amount) internal returns (GlanceVault vault) {
        vm.startPrank(who);
        if (amount != 0) usdg.approve(address(v2), amount);
        vault = GlanceVault(v2.createVaultWithConfig(c, amount));
        vm.stopPrank();
    }

    /// @dev What a new owner did before: create on the old factory, then one owner transaction per setting.
    function _stepByStep(address who, VaultConfig memory c, uint256 amount) internal returns (GlanceVault vault) {
        vm.startPrank(who);
        vault = GlanceVault(v1.createVault(c.usdg));
        vault.setLimits(c.perBuyCap, c.dailyCap, c.dailySellCap, c.maxSlippageBps, c.weekendCapBps);
        for (uint256 i; i < c.tokens.length; ++i) {
            vault.setTokenApproval(c.tokens[i].token, c.tokens[i].priceFeed, true);
            if (c.tokens[i].openMaxAge != 0 || c.tokens[i].closedMaxAge != 0) {
                vault.setTokenFreshness(c.tokens[i].token, c.tokens[i].openMaxAge, c.tokens[i].closedMaxAge);
            }
        }
        for (uint256 i; i < c.routers.length; ++i) {
            vault.setRouterApproval(c.routers[i], true);
        }
        if (c.sequencerUptimeFeed != address(0)) vault.setSequencerUptimeFeed(c.sequencerUptimeFeed);
        if (c.agent != address(0)) vault.setAgent(c.agent, c.agentExpiry);
        if (amount != 0) {
            usdg.approve(address(vault), amount);
            vault.deposit(amount);
        }
        vm.stopPrank();
    }

    /// @dev The vault's own logs (topics and data), in order.
    function _vaultLogs(Vm.Log[] memory logs, address vault) internal pure returns (bytes[] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == vault) n++;
        }
        out = new bytes[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == vault) out[n++] = abi.encode(logs[i].topics, logs[i].data);
        }
    }

    function _assertSameState(GlanceVault a, GlanceVault b) internal {
        assertEq(address(a.usdg()), address(b.usdg()), "usdg");
        assertEq(a.usdgDecimals(), b.usdgDecimals(), "usdgDecimals");
        assertEq(a.agent(), b.agent(), "agent");
        assertEq(a.agentExpiry(), b.agentExpiry(), "agentExpiry");
        assertEq(a.maxSlippageBps(), b.maxSlippageBps(), "maxSlippageBps");
        assertEq(a.weekendCapBps(), b.weekendCapBps(), "weekendCapBps");
        assertEq(a.paused(), b.paused(), "paused");
        assertEq(a.perBuyCap(), b.perBuyCap(), "perBuyCap");
        assertEq(a.dailyCap(), b.dailyCap(), "dailyCap");
        assertEq(a.dailySellCap(), b.dailySellCap(), "dailySellCap");
        assertEq(address(a.sequencerUptimeFeed()), address(b.sequencerUptimeFeed()), "sequencerUptimeFeed");
        assertEq(a.spentInWindow(), b.spentInWindow(), "spentInWindow");
        assertEq(a.soldInWindow(), b.soldInWindow(), "soldInWindow");
        assertEq(a.isActiveAgent(agent), b.isActiveAgent(agent), "isActiveAgent");
        address[3] memory tokens = [address(stockA), address(stockB), makeAddr("unlisted")];
        for (uint256 i; i < tokens.length; ++i) {
            (bool ap, address fa, uint32 oa, uint32 ca) = a.tokenConfig(tokens[i]);
            (bool bp, address fb, uint32 ob, uint32 cb) = b.tokenConfig(tokens[i]);
            assertEq(ap, bp, "approved");
            assertEq(fa, fb, "priceFeed");
            assertEq(oa, ob, "openMaxAge");
            assertEq(ca, cb, "closedMaxAge");
        }
        address other = makeAddr("other router");
        assertEq(a.approvedRouters(address(router)), b.approvedRouters(address(router)), "router");
        assertEq(a.approvedRouters(other), b.approvedRouters(other), "unapproved router");
        for (uint256 s; s < 2; ++s) {
            MarketStatusLib.MarketState st = MarketStatusLib.MarketState(s);
            (uint256 p1, uint256 d1, uint256 e1) = a.effectiveCaps(st);
            (uint256 p2, uint256 d2, uint256 e2) = b.effectiveCaps(st);
            assertEq(p1, p2, "effective perTrade");
            assertEq(d1, d2, "effective dailyBuy");
            assertEq(e1, e2, "effective dailySell");
        }
        assertEq(usdg.balanceOf(address(a)), usdg.balanceOf(address(b)), "USDG held");
    }

    // ---------------------------------------------------------------------
    // Same vault as step by step
    // ---------------------------------------------------------------------

    function test_oneTx_endsInExactlyTheStepByStepState() public {
        VaultConfig memory c = _config();

        vm.recordLogs();
        GlanceVault one = _oneTx(alice, c, 40 * ONE);
        bytes[] memory oneLogs = _vaultLogs(vm.getRecordedLogs(), address(one));

        vm.recordLogs();
        GlanceVault steps = _stepByStep(bob, c, 40 * ONE);
        bytes[] memory stepLogs = _vaultLogs(vm.getRecordedLogs(), address(steps));

        _assertSameState(one, steps);
        assertEq(one.owner(), alice);
        assertEq(steps.owner(), bob);

        // The same events the owner setters emit, with the same values, in the same order.
        assertEq(oneLogs.length, stepLogs.length, "event count");
        for (uint256 i; i < oneLogs.length; ++i) {
            assertEq(oneLogs[i], stepLogs[i], "event");
        }
        // defaults, limits, A approve + default + freshness, B approve + default, router, sequencer, agent, deposit
        assertEq(oneLogs.length, 11);
    }

    function test_oneTx_recordsTheVaultAndEmitsVaultCreated() public {
        VaultConfig memory c = _config();
        address predicted = v2.predictVault(alice, c, 40 * ONE);
        vm.prank(alice);
        usdg.approve(address(v2), 40 * ONE);
        vm.expectEmit(true, true, true, true, address(v2));
        emit GlanceVaultFactoryV2.VaultCreated(alice, predicted, address(usdg));
        vm.prank(alice);
        address vault = v2.createVaultWithConfig(c, 40 * ONE);
        assertEq(vault, predicted);
        assertEq(v2.vaultOf(alice), vault);
        assertEq(v2.vaultOf(bob), address(0));
        // The old factory is a separate registry and keeps working.
        assertEq(v1.vaultOf(alice), address(0));
        vm.prank(alice);
        address old = v1.createVault(address(usdg));
        assertTrue(old != vault);
    }

    function test_oneTx_ownerIsTheCallerAndTheFactoryKeepsNothing() public {
        GlanceVault vault = _oneTx(alice, _config(), 40 * ONE);
        assertEq(vault.owner(), alice);
        assertEq(usdg.balanceOf(address(v2)), 0, "factory holds no USDG");
        assertEq(usdg.allowance(address(v2), address(vault)), 0, "factory approved nothing");
        assertEq(usdg.allowance(alice, address(v2)), 0, "the caller's approval is used up exactly");
        assertEq(usdg.balanceOf(address(vault)), 40 * ONE);
        assertEq(usdg.balanceOf(alice), 960 * ONE);

        // The factory has no role at all: every owner function refuses it.
        vm.startPrank(address(v2));
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.withdraw(address(usdg), 1);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.setAgent(address(v2), uint64(block.timestamp + 1 days));
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.setPaused(true);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.setLimits(1, 1, 1, 0, 0);
        vm.stopPrank();

        // The owner has every right, straight away.
        vm.prank(alice);
        vault.withdraw(address(usdg), 40 * ONE);
        assertEq(usdg.balanceOf(alice), 1_000 * ONE);
    }

    function test_oneTx_zeroDepositWorksAndNeedsNoApproval() public {
        VaultConfig memory c = _config();
        vm.recordLogs();
        vm.prank(alice);
        GlanceVault vault = GlanceVault(v2.createVaultWithConfig(c, 0));
        bytes[] memory logs = _vaultLogs(vm.getRecordedLogs(), address(vault));
        assertEq(usdg.balanceOf(address(vault)), 0);
        assertEq(usdg.balanceOf(alice), 1_000 * ONE);
        assertEq(logs.length, 10, "no Deposited event");
        GlanceVault steps = _stepByStep(bob, c, 0);
        _assertSameState(vault, steps);
    }

    function test_oneTx_theAgentCanTradeImmediately() public {
        GlanceVault vault = _oneTx(alice, _config(), 40 * ONE);
        uint256 minOut = MarketStatusLib.usdgToTokenAmount(10 * ONE, 6, uint256(PRICE), 8, 18);
        // The configured sequencer feed is live: it just came up, so prices aren't trusted for its grace hour.
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.SequencerGracePeriod.selector, START + 3_600));
        vault.buy(address(stockA), address(router), 10 * ONE, minOut);
        vm.warp(START + 3_601);
        feedA.setUpdatedAt(block.timestamp);
        vm.prank(agent);
        vault.buy(address(stockA), address(router), 10 * ONE, minOut);
        assertEq(usdg.balanceOf(address(vault)), 30 * ONE);
        assertEq(vault.spentInWindow(), 10 * ONE);
        // And every guard applies: over the per-trade cap is refused.
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, 90 * ONE, 80 * ONE));
        vault.buy(address(stockA), address(router), 90 * ONE, 0);
    }

    function test_oneTx_noAgentAndNoSequencerFeedLeaveThemUnset() public {
        VaultConfig memory c = _config();
        c.agent = address(0);
        c.agentExpiry = 0;
        c.sequencerUptimeFeed = address(0);
        GlanceVault vault = _oneTx(alice, c, 0);
        assertEq(vault.agent(), address(0));
        assertEq(vault.agentExpiry(), 0);
        assertEq(address(vault.sequencerUptimeFeed()), address(0));
    }

    function test_oneTx_onePerOwner() public {
        GlanceVault vault = _oneTx(alice, _config(), 0);
        VaultConfig memory c = _config();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GlanceVaultFactoryV2.VaultAlreadyExists.selector, address(vault)));
        v2.createVaultWithConfig(c, 0);
    }

    function testFuzz_oneTx_depositArrivesExactly(uint256 amount) public {
        amount = bound(amount, 0, 1_000 * ONE);
        GlanceVault vault = _oneTx(alice, _config(), amount);
        assertEq(usdg.balanceOf(address(vault)), amount);
        assertEq(usdg.balanceOf(alice), 1_000 * ONE - amount);
        assertEq(usdg.balanceOf(address(v2)), 0);
        assertEq(usdg.allowance(alice, address(v2)), 0);
    }

    // ---------------------------------------------------------------------
    // Invalid configs: the setters' own errors, and nothing left behind
    // ---------------------------------------------------------------------

    /// @dev The one-transaction path fails with `err`, leaves no vault and moves no USDG; the setter fails the same way.
    function _expectSameRevert(VaultConfig memory c, bytes memory err, bytes memory setterCall) internal {
        vm.startPrank(alice);
        usdg.approve(address(v2), 40 * ONE);
        vm.expectRevert(err);
        v2.createVaultWithConfig(c, 40 * ONE);
        vm.stopPrank();
        assertEq(v2.vaultOf(alice), address(0));
        assertEq(usdg.balanceOf(alice), 1_000 * ONE);

        if (setterCall.length == 0) return;
        address existing = v1.vaultOf(bob);
        if (existing == address(0)) existing = address(_stepByStep(bob, _config(), 0));
        vm.prank(bob);
        (bool ok, bytes memory ret) = existing.call(setterCall);
        assertFalse(ok, "setter accepted it");
        assertEq(ret, err, "setter reverted differently");
    }

    function test_invalid_limits() public {
        bytes memory err = abi.encodeWithSelector(GlanceVault.InvalidLimits.selector);
        VaultConfig memory c = _config();
        c.perBuyCap = 0;
        _expectSameRevert(c, err, abi.encodeCall(GlanceVault.setLimits, (0, c.dailyCap, c.dailySellCap, 75, 3_000)));

        c = _config();
        c.perBuyCap = c.dailyCap + 1;
        _expectSameRevert(
            c, err, abi.encodeCall(GlanceVault.setLimits, (c.perBuyCap, c.dailyCap, c.dailySellCap, 75, 3_000))
        );

        c = _config();
        c.maxSlippageBps = 1_001;
        _expectSameRevert(
            c, err, abi.encodeCall(GlanceVault.setLimits, (c.perBuyCap, c.dailyCap, c.dailySellCap, 1_001, 3_000))
        );

        c = _config();
        c.weekendCapBps = 10_001;
        _expectSameRevert(
            c, err, abi.encodeCall(GlanceVault.setLimits, (c.perBuyCap, c.dailyCap, c.dailySellCap, 75, 10_001))
        );
    }

    function test_invalid_agentExpiry() public {
        VaultConfig memory c = _config();
        c.agentExpiry = uint64(block.timestamp + 30 days + 1);
        _expectSameRevert(
            c,
            abi.encodeWithSelector(GlanceVault.InvalidAgentExpiry.selector, c.agentExpiry),
            abi.encodeCall(GlanceVault.setAgent, (agent, c.agentExpiry))
        );
        c.agentExpiry = uint64(block.timestamp);
        _expectSameRevert(
            c,
            abi.encodeWithSelector(GlanceVault.InvalidAgentExpiry.selector, c.agentExpiry),
            abi.encodeCall(GlanceVault.setAgent, (agent, c.agentExpiry))
        );
    }

    function test_invalid_tokens() public {
        VaultConfig memory c = _config();
        c.tokens[0].token = address(usdg); // USDG can't be a stock
        _expectSameRevert(
            c,
            abi.encodeWithSelector(GlanceVault.InvalidTokenConfig.selector),
            abi.encodeCall(GlanceVault.setTokenApproval, (address(usdg), address(feedA), true))
        );

        c = _config();
        c.tokens[0].priceFeed = address(0);
        _expectSameRevert(
            c,
            abi.encodeWithSelector(GlanceVault.InvalidTokenConfig.selector),
            abi.encodeCall(GlanceVault.setTokenApproval, (address(stockA), address(0), true))
        );

        c = _config();
        c.tokens[0].token = address(0);
        _expectSameRevert(
            c,
            abi.encodeWithSelector(GlanceVault.ZeroAddress.selector),
            abi.encodeCall(GlanceVault.setTokenApproval, (address(0), address(feedA), true))
        );

        c = _config();
        c.tokens[0].closedMaxAge = c.tokens[0].openMaxAge; // closed must exceed open
        _expectSameRevert(
            c,
            abi.encodeWithSelector(GlanceVault.InvalidFreshness.selector, uint32(72_000), uint32(72_000)),
            abi.encodeCall(GlanceVault.setTokenFreshness, (address(stockA), 72_000, 72_000))
        );

        c = _config();
        c.tokens[0].closedMaxAge = 7 days + 1;
        _expectSameRevert(
            c,
            abi.encodeWithSelector(GlanceVault.InvalidFreshness.selector, uint32(72_000), uint32(7 days + 1)),
            abi.encodeCall(GlanceVault.setTokenFreshness, (address(stockA), 72_000, 7 days + 1))
        );
    }

    function test_invalid_routerAndUsdg() public {
        VaultConfig memory c = _config();
        c.routers[0] = address(0);
        _expectSameRevert(
            c,
            abi.encodeWithSelector(GlanceVault.ZeroAddress.selector),
            abi.encodeCall(GlanceVault.setRouterApproval, (address(0), true))
        );
        c = _config();
        c.usdg = address(0);
        _expectSameRevert(c, abi.encodeWithSelector(GlanceVaultFactoryV2.ZeroAddress.selector), "");
    }

    // ---------------------------------------------------------------------
    // The transfer failing, fee tokens, reentrancy
    // ---------------------------------------------------------------------

    function test_transfer_withoutApprovalRevertsCleanly() public {
        VaultConfig memory c = _config();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(v2), 0, 40 * ONE)
        );
        v2.createVaultWithConfig(c, 40 * ONE);
        assertEq(v2.vaultOf(alice), address(0));
    }

    function test_transfer_moreThanTheCallerHasRevertsCleanly() public {
        VaultConfig memory c = _config();
        vm.startPrank(alice);
        usdg.approve(address(v2), 2_000 * ONE);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 1_000 * ONE, 2_000 * ONE)
        );
        v2.createVaultWithConfig(c, 2_000 * ONE);
        vm.stopPrank();
        assertEq(v2.vaultOf(alice), address(0));
        assertEq(usdg.balanceOf(alice), 1_000 * ONE);
    }

    function test_transfer_tokenReturningFalseReverts() public {
        FalseToken bad = new FalseToken();
        VaultConfig memory c = _config();
        c.usdg = address(bad);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(bad)));
        v2.createVaultWithConfig(c, 1);
        assertEq(v2.vaultOf(alice), address(0));
    }

    function test_transfer_shortDeliveryIsCaughtByTheVault() public {
        FeeToken fee = new FeeToken();
        fee.mint(alice, 100 * ONE);
        VaultConfig memory c = _config();
        c.usdg = address(fee);
        vm.startPrank(alice);
        fee.approve(address(v2), 100 * ONE);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.InsufficientBalance.selector, 99 * ONE, 100 * ONE));
        v2.createVaultWithConfig(c, 100 * ONE);
        vm.stopPrank();
        assertEq(fee.balanceOf(alice), 100 * ONE);
        assertEq(v2.vaultOf(alice), address(0));
    }

    function test_reentrancy_fromTheTokenIsRefused() public {
        ReentrantToken re = new ReentrantToken();
        re.mint(alice, 100 * ONE);
        VaultConfig memory c = _config();
        c.usdg = address(re);
        re.arm(address(v2), abi.encodeCall(GlanceVaultFactoryV2.createVaultWithConfig, (c, 0)));
        vm.startPrank(alice);
        re.approve(address(v2), 10 * ONE);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        v2.createVaultWithConfig(c, 10 * ONE);
        vm.stopPrank();
        assertEq(v2.vaultOf(alice), address(0));
        assertEq(v2.vaultOf(address(re)), address(0));
        assertEq(re.balanceOf(alice), 100 * ONE);
    }

    /// @dev Someone sending USDG to a predicted address first doesn't change who owns the vault or break creation.
    function test_donationToThePredictedAddressIsHarmless() public {
        VaultConfig memory c = _config();
        address predicted = v2.predictVault(alice, c, 40 * ONE);
        vm.prank(bob);
        usdg.transfer(predicted, 5 * ONE);
        GlanceVault vault = _oneTx(alice, c, 40 * ONE);
        assertEq(address(vault), predicted);
        assertEq(vault.owner(), alice);
        assertEq(usdg.balanceOf(address(vault)), 45 * ONE);
    }

    function test_configuredVaultIsAGlanceVault() public {
        GlanceVault vault = _oneTx(alice, _config(), 0);
        // Same runtime interface, so the API and the console read it as any other GlanceVault.
        assertEq(vault.BPS(), 10_000);
        assertEq(vault.MAX_AGENT_TTL(), 30 days);
        assertGt(address(vault).code.length, 0);
        assertGt(type(ConfiguredGlanceVault).creationCode.length, 0);
    }
}
