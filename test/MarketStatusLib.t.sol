// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {MarketStatusLib} from "../src/MarketStatusLib.sol";
import {MockPriceFeed} from "./mocks/MockPriceFeed.sol";

/// @dev Exposes the library's internal functions as external calls so reverts can be asserted.
contract MarketStatusHarness {
    function read(AggregatorV3Interface feed) external view returns (MarketStatusLib.OracleReading memory) {
        return MarketStatusLib.read(feed);
    }
}

contract MarketStatusLibTest is Test {
    uint256 internal constant START = 1_750_000_000;

    MarketStatusHarness internal harness;
    MockPriceFeed internal feed;

    function setUp() public {
        vm.warp(START);
        harness = new MarketStatusHarness();
        feed = new MockPriceFeed(8, 200e8);
    }

    // ---------------------------------------------------------------------
    // Classification
    // ---------------------------------------------------------------------

    function test_classify_boundaries() public pure {
        uint256 t = START;
        assertEq(uint8(MarketStatusLib.classify(t, t)), uint8(MarketStatusLib.MarketState.OPEN));
        assertEq(uint8(MarketStatusLib.classify(t - 1 hours, t)), uint8(MarketStatusLib.MarketState.OPEN));
        assertEq(uint8(MarketStatusLib.classify(t - 1 hours - 1, t)), uint8(MarketStatusLib.MarketState.CLOSED));
        assertEq(uint8(MarketStatusLib.classify(t - 30 hours, t)), uint8(MarketStatusLib.MarketState.CLOSED));
        assertEq(uint8(MarketStatusLib.classify(t - 80 hours, t)), uint8(MarketStatusLib.MarketState.CLOSED));
        assertEq(uint8(MarketStatusLib.classify(t - 80 hours - 1, t)), uint8(MarketStatusLib.MarketState.STALE));
        assertEq(uint8(MarketStatusLib.classify(0, t)), uint8(MarketStatusLib.MarketState.STALE));
    }

    function testFuzz_classify_matchesThresholds(uint256 age) public pure {
        age = bound(age, 0, START);
        MarketStatusLib.MarketState s = MarketStatusLib.classify(START - age, START);
        if (age <= MarketStatusLib.OPEN_MAX_AGE) assertEq(uint8(s), uint8(MarketStatusLib.MarketState.OPEN));
        else if (age <= MarketStatusLib.CLOSED_MAX_AGE) assertEq(uint8(s), uint8(MarketStatusLib.MarketState.CLOSED));
        else assertEq(uint8(s), uint8(MarketStatusLib.MarketState.STALE));
    }

    // ---------------------------------------------------------------------
    // Reading the feed
    // ---------------------------------------------------------------------

    function test_read_returnsAllFields() public {
        feed.setUpdatedAt(START - 30 hours);
        MarketStatusLib.OracleReading memory r = harness.read(feed);
        assertEq(r.price, 200e8);
        assertEq(r.decimals, 8);
        assertEq(r.updatedAt, START - 30 hours);
        assertEq(uint8(r.state), uint8(MarketStatusLib.MarketState.CLOSED));
    }

    function test_read_staleIsReportedNotReverted() public {
        feed.setUpdatedAt(START - 81 hours);
        assertEq(uint8(harness.read(feed).state), uint8(MarketStatusLib.MarketState.STALE));
    }

    function test_revert_read_zeroPrice() public {
        feed.setPrice(0);
        vm.expectRevert(abi.encodeWithSelector(MarketStatusLib.InvalidOraclePrice.selector, int256(0)));
        harness.read(feed);
    }

    function test_revert_read_negativePrice() public {
        feed.setPrice(-5e8);
        vm.expectRevert(abi.encodeWithSelector(MarketStatusLib.InvalidOraclePrice.selector, int256(-5e8)));
        harness.read(feed);
    }

    function test_revert_read_futureTimestamp() public {
        feed.setUpdatedAt(START + 1);
        vm.expectRevert(abi.encodeWithSelector(MarketStatusLib.OracleTimestampInFuture.selector, START + 1));
        harness.read(feed);
    }

    // ---------------------------------------------------------------------
    // Decimal conversions
    // ---------------------------------------------------------------------

    function test_usdgToToken_6dpUsdg_8dpFeed_18dpToken() public pure {
        // 100 USDG at $200 = 0.5 shares.
        assertEq(MarketStatusLib.usdgToTokenAmount(100e6, 6, 200e8, 8, 18), 0.5e18);
    }

    function test_usdgToToken_18dpUsdg_8dpFeed_18dpToken() public pure {
        assertEq(MarketStatusLib.usdgToTokenAmount(100e18, 18, 200e8, 8, 18), 0.5e18);
    }

    function test_usdgToToken_18dpUsdg_18dpFeed_6dpToken() public pure {
        assertEq(MarketStatusLib.usdgToTokenAmount(100e18, 18, 200e18, 18, 6), 0.5e6);
    }

    function test_usdgToToken_smallExponentBranch() public pure {
        // pd + td = 8 < ud = 18, exercising the division-only branch: 200 USDG at $200 = 1 whole 0-dp token.
        assertEq(MarketStatusLib.usdgToTokenAmount(200e18, 18, 200e8, 8, 0), 1);
        assertEq(MarketStatusLib.usdgToTokenAmount(399e18, 18, 200e8, 8, 0), 1, "rounds down");
    }

    function test_tokenToUsdg_matchesExamples() public pure {
        assertEq(MarketStatusLib.tokenToUsdgAmount(0.5e18, 18, 200e8, 8, 6), 100e6);
        assertEq(MarketStatusLib.tokenToUsdgAmount(0.5e18, 18, 200e8, 8, 18), 100e18);
        assertEq(MarketStatusLib.tokenToUsdgAmount(1, 0, 200e8, 8, 18), 200e18, "multiply-only branch");
    }

    function test_conversion_fractionalPrice() public pure {
        // $187.53 per share, 250 USDG -> 1.333119...e18 tokens, floor.
        uint256 out = MarketStatusLib.usdgToTokenAmount(250e6, 6, 187_53000000, 8, 18);
        assertEq(out, Math.mulDiv(250e6, 1e20, 187_53000000));
    }

    /// @dev usdg -> token -> usdg never creates value, and loses less than one raw token's worth plus rounding.
    function testFuzz_roundTrip_neverCreatesValue(uint256 usdgAmount, uint256 price, uint8 ud, uint8 pd, uint8 td)
        public
        pure
    {
        ud = uint8(bound(ud, 0, 18));
        pd = uint8(bound(pd, 0, 18));
        td = uint8(bound(td, 0, 18));
        price = bound(price, 1, 1e12 * 10 ** pd); // up to $1T per share
        usdgAmount = bound(usdgAmount, 0, 1e15 * 10 ** ud); // up to 1e15 USDG

        uint256 tokens = MarketStatusLib.usdgToTokenAmount(usdgAmount, ud, price, pd, td);
        uint256 back = MarketStatusLib.tokenToUsdgAmount(tokens, td, price, pd, ud);
        assertLe(back, usdgAmount);

        // Loss bound: the value of one raw token unit (rounded up) plus one raw USDG unit.
        uint256 oneTokenValue = MarketStatusLib.tokenToUsdgAmount(1, td, price, pd, ud) + 1;
        assertLe(usdgAmount - back, oneTokenValue + 1);
    }

    function testFuzz_usdgToToken_monotonic(uint256 a, uint256 b, uint256 price) public pure {
        price = bound(price, 1, 1e20);
        a = bound(a, 0, 1e30);
        b = bound(b, a, 1e30);
        assertLe(
            MarketStatusLib.usdgToTokenAmount(a, 6, price, 8, 18), MarketStatusLib.usdgToTokenAmount(b, 6, price, 8, 18)
        );
    }
}
