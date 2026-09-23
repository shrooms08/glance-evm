// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";
import {GlanceVault} from "../../src/GlanceVault.sol";
import {GlanceVaultFactory} from "../../src/GlanceVaultFactory.sol";
import {MarketStatusLib} from "../../src/MarketStatusLib.sol";
import {StockDesk} from "../../src/testnet/StockDesk.sol";
import {TestPriceFeed} from "../../src/testnet/TestPriceFeed.sol";

/// @dev Shared fork plumbing. Every test here needs network access: when an RPC is unreachable the suite is skipped,
///      so a plain offline `forge test` still passes. Set FORK_BLOCK_TESTNET / FORK_BLOCK_MAINNET to pin blocks;
///      by default each fork starts at the latest block. Run with `make test-fork`.
abstract contract ForkBase is Test {
    uint256 internal constant USDG_UNIT = 1e6;
    uint256 internal constant SHARE = 1e18;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");

    /// @dev Selects a fork of `alias_`, or returns false if the RPC cannot be reached.
    function _selectFork(string memory alias_, string memory blockEnv) internal returns (bool ok, uint256 forkId) {
        uint256 pinned = vm.envOr(blockEnv, uint256(0));
        if (pinned == 0) {
            try vm.createSelectFork(alias_) returns (uint256 id) {
                return (true, id);
            } catch {
                return (false, 0);
            }
        }
        try vm.createSelectFork(alias_, pinned) returns (uint256 id) {
            return (true, id);
        } catch {
            return (false, 0);
        }
    }

    /// @dev deal() finds the balance slot by watching balanceOf's storage reads. It can silently miss on unusual
    ///      layouts, so assert the balance really moved. Both Paxos USDG (an EIP-1967 proxy) and the Robinhood Stock
    ///      Tokens (beacon proxies) work with the default search, so no manual slot is needed.
    function _dealChecked(address token, address to, uint256 amount) internal {
        uint256 supplyBefore = IERC20(token).totalSupply();
        deal(token, to, amount);
        assertEq(IERC20(token).balanceOf(to), amount, "deal() did not set the real token balance");
        assertEq(IERC20(token).totalSupply(), supplyBefore, "deal() changed totalSupply unexpectedly");
    }

    /// @dev Oracle-implied tokens for `usdgIn` minus the desk spread, computed independently of the contracts.
    function _expectedBuy(uint256 usdgIn, uint256 price8, uint256 spreadBps) internal pure returns (uint256) {
        // tokens(18dp) = usdg(6dp) * 10^(8 + 18 - 6) / price(8dp)
        return usdgIn * 1e20 / price8 * (10_000 - spreadBps) / 10_000;
    }

    function _deployVault(address usdg, StockDesk desk, address token, address feed)
        internal
        returns (GlanceVault vault)
    {
        GlanceVaultFactory factory = new GlanceVaultFactory();
        vm.startPrank(owner);
        vault = GlanceVault(factory.createVault(usdg));
        vault.setTokenApproval(token, feed, true);
        vault.setRouterApproval(address(desk), true);
        vault.setAgent(agent, uint64(block.timestamp + 7 days));
        vm.stopPrank();
    }
}

/// @notice The full Glance flow on a fork of Robinhood Chain TESTNET, against the real Paxos USDG and the real faucet
///         Stock Tokens. Robinhood testnet has no Chainlink feeds, so prices come from live reads of the real Chainlink
///         feeds on Robinhood MAINNET, loaded into our TestPriceFeed stand-in.
contract GlanceVaultTestnetForkTest is ForkBase {
    // Addresses verified in docs/CHAIN_NOTES.md.
    address internal constant PAXOS_USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;
    address internal constant TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address internal constant AMZN = 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02;
    address internal constant MAINNET_TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address internal constant MAINNET_AMZN_FEED = 0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C;

    uint256 internal liveTsla;
    uint256 internal liveAmzn;

    StockDesk internal desk;
    TestPriceFeed internal tslaFeed;
    GlanceVault internal vault;

    function setUp() public {
        // Live Chainlink prices first, from mainnet.
        (bool mainnetUp,) = _selectFork("robinhood_mainnet", "FORK_BLOCK_MAINNET");
        if (!mainnetUp) {
            vm.skip(true);
            return;
        }
        liveTsla = _answer(MAINNET_TSLA_FEED);
        liveAmzn = _answer(MAINNET_AMZN_FEED);

        (bool testnetUp,) = _selectFork("robinhood_testnet", "FORK_BLOCK_TESTNET");
        if (!testnetUp) {
            vm.skip(true);
            return;
        }
        console2.log("testnet fork block", block.number);
        console2.log("live Chainlink TSLA/USD (8dp)", liveTsla);

        assertEq(IERC20Metadata(PAXOS_USDG).symbol(), "USDG");
        assertEq(IERC20Metadata(PAXOS_USDG).decimals(), 6);
        assertEq(IERC20Metadata(TSLA).symbol(), "TSLA");

        vm.startPrank(owner);
        desk = new StockDesk(PAXOS_USDG, owner);
        tslaFeed = new TestPriceFeed(8, "TSLA / USD", int256(liveTsla), owner);
        desk.setFeed(TSLA, address(tslaFeed));
        vm.stopPrank();

        // Desk inventory in the real tokens.
        _dealChecked(PAXOS_USDG, address(desk), 50_000 * USDG_UNIT);
        _dealChecked(TSLA, address(desk), 100 * SHARE);

        vault = _deployVault(PAXOS_USDG, desk, TSLA, address(tslaFeed));
        _dealChecked(PAXOS_USDG, owner, 1_000 * USDG_UNIT);
    }

    function _answer(address feed) internal view returns (uint256) {
        (, int256 answer,,,) = AggregatorV3Interface(feed).latestRoundData();
        assertGt(answer, 0, "live Chainlink answer must be positive");
        return uint256(answer);
    }

    function test_fork_vaultReadsRealUsdgDecimals() public view {
        assertEq(address(vault.usdg()), PAXOS_USDG);
        assertEq(vault.usdgDecimals(), 6);
        assertEq(vault.perBuyCap(), vault.DEFAULT_PER_BUY_CAP_WHOLE() * USDG_UNIT);
    }

    function test_fork_fullFlowOnRealPaxosUsdg() public {
        // Deposit real USDG.
        vm.startPrank(owner);
        IERC20(PAXOS_USDG).approve(address(vault), 1_000 * USDG_UNIT);
        vault.deposit(1_000 * USDG_UNIT);
        vm.stopPrank();
        assertEq(IERC20(PAXOS_USDG).balanceOf(address(vault)), 1_000 * USDG_UNIT);
        assertEq(IERC20(PAXOS_USDG).balanceOf(owner), 0);

        // Agent buys real TSLA at the live Chainlink price minus the desk spread.
        uint256 usdgIn = 100 * USDG_UNIT;
        uint256 expected = _expectedBuy(usdgIn, liveTsla, desk.spreadBps());
        assertEq(desk.quoteBuy(TSLA, usdgIn), expected, "desk quote matches the live price");
        uint256 deskTslaBefore = IERC20(TSLA).balanceOf(address(desk));

        vm.prank(agent);
        uint256 bought = vault.buy(TSLA, address(desk), usdgIn, expected);

        assertEq(bought, expected);
        assertEq(IERC20(TSLA).balanceOf(address(vault)), expected, "vault holds the real TSLA");
        assertEq(IERC20(TSLA).balanceOf(address(desk)), deskTslaBefore - expected);
        assertEq(IERC20(PAXOS_USDG).balanceOf(address(vault)), 900 * USDG_UNIT);
        assertEq(vault.spentInWindow(), usdgIn);

        // Agent sells half back.
        uint256 half = bought / 2;
        uint256 quote = desk.quoteSell(TSLA, half);
        vm.prank(agent);
        uint256 usdgOut = vault.sell(TSLA, address(desk), half, quote);
        assertEq(usdgOut, quote);
        assertEq(IERC20(PAXOS_USDG).balanceOf(address(vault)), 900 * USDG_UNIT + usdgOut);
        // The sell window records the oracle value of the tokens sold: tokens(18dp) * price(8dp) / 10^(8 + 18 - 6).
        assertEq(vault.soldInWindow(), half * liveTsla / 1e20);

        // The agent can never withdraw.
        vm.prank(agent);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.withdraw(PAXOS_USDG, 1);
        vm.prank(agent);
        vm.expectRevert(GlanceVault.NotOwner.selector);
        vault.withdraw(TSLA, 1);

        // The owner withdraws everything, in real tokens.
        uint256 vaultUsdg = IERC20(PAXOS_USDG).balanceOf(address(vault));
        uint256 vaultTsla = IERC20(TSLA).balanceOf(address(vault));
        vm.startPrank(owner);
        vault.withdraw(PAXOS_USDG, vaultUsdg);
        vault.withdraw(TSLA, vaultTsla);
        vm.stopPrank();
        assertEq(IERC20(PAXOS_USDG).balanceOf(owner), vaultUsdg);
        assertEq(IERC20(TSLA).balanceOf(owner), vaultTsla);
        assertEq(IERC20(PAXOS_USDG).balanceOf(address(vault)), 0);
        assertEq(IERC20(TSLA).balanceOf(address(vault)), 0);
        assertEq(IERC20(PAXOS_USDG).balanceOf(agent), 0);
        assertEq(IERC20(TSLA).balanceOf(agent), 0);
    }

    function test_fork_weekendCapsOnRealTokens() public {
        vm.startPrank(owner);
        IERC20(PAXOS_USDG).approve(address(vault), 1_000 * USDG_UNIT);
        vault.deposit(1_000 * USDG_UNIT);
        tslaFeed.setUpdatedAt(block.timestamp - 30 hours);
        vm.stopPrank();

        uint256 fullCap = vault.perBuyCap();
        uint256 quote = desk.quoteBuy(TSLA, fullCap);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, fullCap, fullCap / 4));
        vault.buy(TSLA, address(desk), fullCap, quote);

        quote = desk.quoteBuy(TSLA, fullCap / 4);
        vm.prank(agent);
        vault.buy(TSLA, address(desk), fullCap / 4, quote);
    }

    function test_fork_secondRealStockPricedLive() public {
        // AMZN: another real faucet Stock Token, priced from its own live Chainlink mainnet feed.
        vm.startPrank(owner);
        TestPriceFeed amznFeed = new TestPriceFeed(8, "AMZN / USD", int256(liveAmzn), owner);
        desk.setFeed(AMZN, address(amznFeed));
        vault.setTokenApproval(AMZN, address(amznFeed), true);
        IERC20(PAXOS_USDG).approve(address(vault), 100 * USDG_UNIT);
        vault.deposit(100 * USDG_UNIT);
        vm.stopPrank();
        _dealChecked(AMZN, address(desk), 100 * SHARE);

        uint256 expected = _expectedBuy(50 * USDG_UNIT, liveAmzn, desk.spreadBps());
        vm.prank(agent);
        assertEq(vault.buy(AMZN, address(desk), 50 * USDG_UNIT, expected), expected);
        assertEq(IERC20(AMZN).balanceOf(address(vault)), expected);
    }
}

/// @notice On a fork of Robinhood Chain MAINNET, where real Chainlink equity feeds exist: the vault prices and classifies
///         the market straight off the real TSLA / USD feed, with real Paxos USDG and the real TSLA Stock Token.
///         This is where the 24h heartbeat matters, so it also proves per-token freshness thresholds.
contract GlanceVaultMainnetForkTest is ForkBase {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address internal constant TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;

    /// @dev Thresholds for Chainlink's 24h-heartbeat equity feeds.
    uint32 internal constant HB24_OPEN = 26 hours;
    uint32 internal constant HB24_CLOSED = 96 hours;

    StockDesk internal desk;
    GlanceVault internal vault;
    uint256 internal price;
    uint256 internal updatedAt;

    function setUp() public {
        (bool up,) = _selectFork("robinhood_mainnet", "FORK_BLOCK_MAINNET");
        if (!up) {
            vm.skip(true);
            return;
        }
        (, int256 answer,, uint256 updated,) = AggregatorV3Interface(TSLA_FEED).latestRoundData();
        assertGt(answer, 0);
        price = uint256(answer);
        updatedAt = updated;
        console2.log("mainnet fork block", block.number);
        console2.log("live Chainlink TSLA/USD (8dp)", price);
        console2.log("feed age (s)", block.timestamp - updatedAt);

        vm.startPrank(owner);
        desk = new StockDesk(USDG, owner);
        desk.setFeed(TSLA, TSLA_FEED); // the desk prices off the REAL feed
        vm.stopPrank();
        _dealChecked(USDG, address(desk), 50_000 * USDG_UNIT);
        _dealChecked(TSLA, address(desk), 100 * SHARE);

        vault = _deployVault(USDG, desk, TSLA, TSLA_FEED);
        _dealChecked(USDG, owner, 1_000 * USDG_UNIT);
        vm.startPrank(owner);
        IERC20(USDG).approve(address(vault), 1_000 * USDG_UNIT);
        vault.deposit(1_000 * USDG_UNIT);
        vm.stopPrank();
    }

    function test_mainnetFork_buyAtLiveChainlinkPrice() public {
        vm.prank(owner);
        vault.setTokenFreshness(TSLA, HB24_OPEN, HB24_CLOSED);
        // Stay inside every threshold regardless of when the fork was taken.
        vm.warp(updatedAt + 1 hours);

        uint256 usdgIn = 25 * USDG_UNIT; // within the weekend cap too
        uint256 expected = _expectedBuy(usdgIn, price, desk.spreadBps());
        vm.prank(agent);
        assertEq(vault.buy(TSLA, address(desk), usdgIn, expected), expected);
        assertEq(IERC20(TSLA).balanceOf(address(vault)), expected);
    }

    /// @dev The real feed, 20 hours after its last update (well inside its 24h heartbeat, so perfectly healthy).
    ///      Default thresholds misread it as a closed market and cut the caps to 25%; the per-token 24h-heartbeat
    ///      thresholds read it as OPEN and allow the full cap.
    function test_mainnetFork_realFeedAt20Hours_defaultsVsHeartbeatConfig() public {
        vm.warp(updatedAt + 20 hours);
        uint256 fullCap = vault.perBuyCap();
        uint256 quote = desk.quoteBuy(TSLA, fullCap);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GlanceVault.ExceedsPerTradeCap.selector, fullCap, fullCap / 4));
        vault.buy(TSLA, address(desk), fullCap, quote);

        vm.prank(owner);
        vault.setTokenFreshness(TSLA, HB24_OPEN, HB24_CLOSED);
        vm.expectEmit(true, true, false, false, address(vault));
        emit GlanceVault.Bought(TSLA, address(desk), 0, 0, 0, MarketStatusLib.MarketState.OPEN, 0, 0);
        vm.prank(agent);
        vault.buy(TSLA, address(desk), fullCap, quote);
    }

    function test_mainnetFork_liveStateMatchesIndependentClassification() public {
        vm.prank(owner);
        vault.setTokenFreshness(TSLA, HB24_OPEN, HB24_CLOSED);
        MarketStatusLib.MarketState expectedState =
            MarketStatusLib.classify(updatedAt, block.timestamp, HB24_OPEN, HB24_CLOSED);
        console2.log("live market state (0 OPEN, 1 CLOSED, 2 STALE)", uint8(expectedState));
        // Nothing to trade against if the feed is stale, or older than the desk will quote (long holiday closures).
        if (expectedState == MarketStatusLib.MarketState.STALE || block.timestamp - updatedAt > desk.MAX_PRICE_AGE()) {
            return;
        }

        uint256 usdgIn = 10 * USDG_UNIT;
        uint256 quote = desk.quoteBuy(TSLA, usdgIn);
        (uint256 perTrade, uint256 daily,) = vault.effectiveCaps(expectedState);
        vm.expectEmit(address(vault));
        emit GlanceVault.Bought(TSLA, address(desk), usdgIn, quote, price, expectedState, perTrade, daily);
        vm.prank(agent);
        vault.buy(TSLA, address(desk), usdgIn, quote);
    }
}
