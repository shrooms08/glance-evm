// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {TestPriceFeed} from "../../src/testnet/TestPriceFeed.sol";
import {TestStockToken} from "../../src/testnet/TestStockToken.sol";
import {TestUSDG} from "../../src/testnet/TestUSDG.sol";

contract TestnetStandInsTest is Test {
    uint256 internal constant START = 1_790_000_000;
    address internal owner = makeAddr("owner");
    address internal judge = makeAddr("judge");

    TestUSDG internal usdg;
    TestPriceFeed internal feed;

    function setUp() public {
        vm.warp(START);
        usdg = new TestUSDG(owner);
        feed = new TestPriceFeed(8, "TSLA / USD", 380e8, owner);
    }

    function test_usdg_metadata() public view {
        assertEq(usdg.symbol(), "USDG");
        assertEq(usdg.decimals(), 6);
    }

    function test_usdg_faucet_capPerAddressPerDay() public {
        uint256 cap = usdg.FAUCET_DAILY_CAP();
        vm.startPrank(judge);
        usdg.faucet(cap / 2);
        usdg.faucet(cap / 2);
        assertEq(usdg.balanceOf(judge), cap);
        assertEq(usdg.faucetRemaining(judge), 0);
        vm.expectRevert(abi.encodeWithSelector(TestUSDG.FaucetCapExceeded.selector, 1, 0));
        usdg.faucet(1);

        // A new UTC day resets the allowance.
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        usdg.faucet(cap);
        vm.stopPrank();
        assertEq(usdg.balanceOf(judge), 2 * cap);
    }

    function test_usdg_faucet_isPerAddress() public {
        uint256 cap = usdg.FAUCET_DAILY_CAP();
        vm.prank(judge);
        usdg.faucet(cap);
        vm.prank(owner);
        usdg.faucet(cap);
        assertEq(usdg.balanceOf(owner), cap);
    }

    function test_usdg_ownerMintUncapped_nonOwnerCannotMint() public {
        vm.prank(owner);
        usdg.mint(owner, 1_000_000e6);
        assertEq(usdg.balanceOf(owner), 1_000_000e6);
        vm.prank(judge);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, judge));
        usdg.mint(judge, 1);
    }

    function test_stock_configurableAndOwnerMint() public {
        TestStockToken t = new TestStockToken("TSLA Test Stock", "TSLA", 6, owner);
        assertEq(t.decimals(), 6);
        assertEq(t.symbol(), "TSLA");
        vm.prank(owner);
        t.mint(judge, 5e6);
        assertEq(t.balanceOf(judge), 5e6);
        vm.prank(judge);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, judge));
        t.mint(judge, 1);
    }

    function test_feed_isLabelledAsTest() public view {
        assertTrue(feed.isTestFeed());
        assertEq(feed.description(), "TEST FEED (Glance testnet stand-in): TSLA / USD");
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(answer, 380e8);
        assertEq(updatedAt, START);
    }

    function test_feed_ownerCanSetPriceAndBackdate() public {
        vm.startPrank(owner);
        feed.setPrice(400e8);
        feed.setUpdatedAt(block.timestamp - 30 hours);
        vm.stopPrank();
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(answer, 400e8);
        assertEq(updatedAt, START - 30 hours);
        assertEq(roundId, 3);
    }

    function test_feed_rejectsFutureAndNonOwner() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TestPriceFeed.UpdatedAtInFuture.selector, START + 1));
        feed.setUpdatedAt(START + 1);
        vm.prank(judge);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, judge));
        feed.setPrice(1);
    }
}
