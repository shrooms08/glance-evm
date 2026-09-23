// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {GlanceVault} from "../../src/GlanceVault.sol";
import {MarketStatusLib} from "../../src/MarketStatusLib.sol";
import {RollingSpendLib} from "../../src/RollingSpendLib.sol";
import {VaultFixture} from "../GlanceVault.t.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPriceFeed} from "../mocks/MockPriceFeed.sol";
import {MockRouter} from "../mocks/MockRouter.sol";

/// @dev Drives the vault as the agent (buys and sells), advancing time between calls.
contract AgentHandler is Test {
    GlanceVault internal vault;
    MockERC20 internal usdg;
    MockERC20 internal stock;
    MockPriceFeed internal feed;
    MockRouter internal router;
    address internal agent;
    address internal owner;

    uint256 public now_;
    uint256[] public buyTimes;
    uint256[] public buyNotionals;
    uint256[] public sellTimes;
    uint256[] public sellNotionals;

    constructor(
        GlanceVault vault_,
        MockERC20 usdg_,
        MockERC20 stock_,
        MockPriceFeed feed_,
        MockRouter router_,
        address agent_,
        address owner_
    ) {
        vault = vault_;
        usdg = usdg_;
        stock = stock_;
        feed = feed_;
        router = router_;
        agent = agent_;
        owner = owner_;
        now_ = block.timestamp;
    }

    function buyCount() external view returns (uint256) {
        return buyTimes.length;
    }

    function sellCount() external view returns (uint256) {
        return sellTimes.length;
    }

    /// @dev Advances time, sometimes leaving the feed CLOSED-aged, and keeps the agent key alive.
    function _tick(uint256 dtSeed, uint256 feedSeed) internal {
        now_ += bound(dtSeed, 0, 30 hours);
        vm.warp(now_);
        uint256 age = feedSeed % 4 == 0 ? 30 hours : 0;
        feed.setUpdatedAt(now_ - age);
        vm.prank(owner);
        vault.setAgent(agent, uint64(now_ + 7 days));
    }

    function buy(uint256 amountSeed, uint256 dtSeed, uint256 feedSeed) external {
        _tick(dtSeed, feedSeed);
        uint256 amount = bound(amountSeed, 1, vault.perBuyCap());
        // The router fills at the oracle price, so the oracle quote is always an acceptable minimum.
        uint256 minOut = MarketStatusLib.usdgToTokenAmount(amount, 6, router.price(), 8, 18);
        vm.prank(agent);
        try vault.buy(address(stock), address(router), amount, minOut) {
            buyTimes.push(now_);
            buyNotionals.push(amount);
        } catch {}
    }

    function sell(uint256 fractionSeed, uint256 dtSeed, uint256 feedSeed) external {
        _tick(dtSeed, feedSeed);
        uint256 held = stock.balanceOf(address(vault));
        if (held == 0) return;
        // Keep most sells inside the open-market per-trade cap so the sell window actually fills.
        uint256 maxTokens = MarketStatusLib.usdgToTokenAmount(vault.perBuyCap(), 6, router.price(), 8, 18);
        uint256 tokensIn = bound(fractionSeed, 1, held < maxTokens ? held : maxTokens);
        uint256 before = vault.soldInWindow();
        uint256 minOut = MarketStatusLib.tokenToUsdgAmount(tokensIn, 18, router.price(), 8, 6);
        vm.prank(agent);
        try vault.sell(address(stock), address(router), tokensIn, minOut) {
            // The notional recorded is exactly what the sell window grew by (nothing expires within one block).
            sellTimes.push(now_);
            sellNotionals.push(vault.soldInWindow() - before);
        } catch {}
    }
}

contract GlanceVaultInvariantTest is VaultFixture {
    AgentHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new AgentHandler(vault, usdg, stock, feed, router, agent, owner);
        targetContract(address(handler));
    }

    /// @dev Guards against a vacuous run: the handler must actually get trades through the vault.
    function afterInvariant() public view {
        assertGt(handler.buyCount(), 0, "no buys executed");
        assertGt(handler.sellCount(), 0, "no sells executed");
    }

    /// @dev No 24h window of agent buys ever exceeds the (open-market) daily buy cap.
    function invariant_buyWindowWithinCap() public view {
        uint256 n = handler.buyCount();
        for (uint256 i; i < n; ++i) {
            uint256 ti = handler.buyTimes(i);
            uint256 sum;
            for (uint256 j; j <= i; ++j) {
                if (handler.buyTimes(j) + RollingSpendLib.WINDOW > ti) sum += handler.buyNotionals(j);
            }
            assertLe(sum, DAILY_CAP);
        }
    }

    /// @dev No 24h window of agent sells ever exceeds the (open-market) daily sell cap.
    function invariant_sellWindowWithinCap() public view {
        uint256 n = handler.sellCount();
        for (uint256 i; i < n; ++i) {
            uint256 ti = handler.sellTimes(i);
            uint256 sum;
            for (uint256 j; j <= i; ++j) {
                if (handler.sellTimes(j) + RollingSpendLib.WINDOW > ti) sum += handler.sellNotionals(j);
            }
            assertLe(sum, DAILY_SELL_CAP);
        }
    }

    /// @dev The agent never ends up holding vault funds.
    function invariant_agentHoldsNothing() public view {
        assertEq(usdg.balanceOf(agent), 0);
        assertEq(stock.balanceOf(agent), 0);
    }

    /// @dev The vault never leaves a standing allowance to the router.
    function invariant_noLingeringAllowance() public view {
        assertEq(usdg.allowance(address(vault), address(router)), 0);
        assertEq(stock.allowance(address(vault), address(router)), 0);
    }

    /// @dev Swaps at the oracle price are value-preserving, so USDG spent is fully backed by stock held.
    function invariant_valueConserved() public view {
        uint256 stockValue =
            stock.balanceOf(address(vault)) * uint256(PRICE) / 10 ** (FEED_DECIMALS + STOCK_DECIMALS - USDG_DECIMALS);
        uint256 total = usdg.balanceOf(address(vault)) + stockValue;
        assertApproxEqAbs(total, DEPOSIT, handler.buyCount() + handler.sellCount() + 1);
    }
}
