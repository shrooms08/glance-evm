// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {RollingSpendLib} from "../src/RollingSpendLib.sol";

/// @dev Holds a Window in storage and exposes the library as external calls.
contract RollingSpendHarness {
    using RollingSpendLib for RollingSpendLib.Window;

    RollingSpendLib.Window internal _w;

    /// @dev Mirrors how the vault uses the library: prune, then record.
    function spend(uint256 amount) external {
        _w.prune(block.timestamp);
        _w.record(amount, block.timestamp);
    }

    function prune() external {
        _w.prune(block.timestamp);
    }

    function spentInWindow() external view returns (uint256) {
        return _w.spentInWindow(block.timestamp);
    }

    function total() external view returns (uint256) {
        return _w.total;
    }

    function count() external view returns (uint256) {
        return _w.count;
    }

    function head() external view returns (uint256) {
        return _w.head;
    }
}

contract RollingSpendLibTest is Test {
    uint256 internal constant START = 1_750_000_000;
    uint256 internal constant WINDOW = RollingSpendLib.WINDOW;
    uint256 internal constant CAPACITY = RollingSpendLib.CAPACITY;

    RollingSpendHarness internal h;

    function setUp() public {
        vm.warp(START);
        h = new RollingSpendHarness();
    }

    // ---------------------------------------------------------------------
    // Unit
    // ---------------------------------------------------------------------

    function test_record_andExpire() public {
        h.spend(10);
        vm.warp(START + 1);
        h.spend(5);
        assertEq(h.spentInWindow(), 15);

        vm.warp(START + WINDOW - 1);
        assertEq(h.spentInWindow(), 15, "still inside the window one second before expiry");

        vm.warp(START + WINDOW);
        assertEq(h.spentInWindow(), 5, "first entry expires at exactly +24h");
        h.prune();
        assertEq(h.total(), 5);
        assertEq(h.count(), 1);
    }

    function test_sameTimestamp_merges() public {
        h.spend(1);
        h.spend(2);
        h.spend(3);
        assertEq(h.count(), 1);
        assertEq(h.total(), 6);
    }

    function test_full_revertsWithExpiryHint() public {
        for (uint256 i; i < CAPACITY; ++i) {
            vm.warp(START + i);
            h.spend(1);
        }
        vm.warp(START + CAPACITY);
        vm.expectRevert(abi.encodeWithSelector(RollingSpendLib.SpendBufferFull.selector, START + WINDOW));
        h.spend(1);

        // A spend in the same second as the newest entry merges, so it does not need a slot.
        vm.warp(START + CAPACITY - 1);
        h.spend(1);
        assertEq(h.total(), CAPACITY + 1);
    }

    function test_wraparound() public {
        for (uint256 i; i < CAPACITY; ++i) {
            vm.warp(START + i * 1 hours);
            h.spend(1);
        }
        // At START + 31h + 10h the first 18 entries (hours 0..17) have expired.
        vm.warp(START + 41 hours);
        for (uint256 i; i < 18; ++i) {
            h.spend(100);
            vm.warp(block.timestamp + 1);
        }
        assertEq(h.count(), CAPACITY);
        assertEq(h.head(), 18);
        assertEq(h.total(), (CAPACITY - 18) + 18 * 100);
        assertEq(h.spentInWindow(), h.total());
    }

    function test_revert_amountTooLarge() public {
        vm.expectRevert();
        h.spend(uint256(type(uint192).max) + 1);
    }

    // ---------------------------------------------------------------------
    // Model-based fuzz
    // ---------------------------------------------------------------------

    /// @dev Reference model: every successful spend, unbounded.
    uint256[] internal _times;
    uint256[] internal _amounts;

    /// @dev Drives the ring buffer with random spends and time jumps and checks it against an unbounded list
    ///      after every step: running total, live-entry count, and exactly when SpendBufferFull must fire.
    function testFuzz_matchesReferenceModel(uint256 seed) public {
        for (uint256 i; i < 120; ++i) {
            _modelStep(uint256(keccak256(abi.encode(seed, i))));
        }
    }

    function _modelStep(uint256 r) internal {
        uint256 mode = r % 5;
        // Bias towards dense bursts so the buffer actually fills and wraps.
        uint256 dt =
            mode == 0 ? 0 : mode <= 2 ? (r >> 8) % 30 minutes : mode == 3 ? (r >> 8) % 6 hours : (r >> 8) % 48 hours;
        vm.warp(block.timestamp + dt);
        uint256 amount = bound(r >> 128, 1, 1e24);

        (uint256 sum, uint256 slots, bool lastIsNow) = _model(_times, _amounts, _times.length, block.timestamp);
        assertEq(h.spentInWindow(), sum, "view total");

        if (!lastIsNow && slots == CAPACITY) {
            uint256 freesAt = _oldestLive(_times, _times.length) + WINDOW;
            vm.expectRevert(abi.encodeWithSelector(RollingSpendLib.SpendBufferFull.selector, freesAt));
            h.spend(amount);
            return;
        }

        h.spend(amount);
        _times.push(block.timestamp);
        _amounts.push(amount);
        (sum, slots,) = _model(_times, _amounts, _times.length, block.timestamp);
        assertEq(h.total(), sum, "running total");
        assertEq(h.count(), slots, "live entries");
    }

    /// @dev For any sequence of spends and time jumps, the running total after prune equals the sum of spends in
    ///      the trailing 24 hours.
    function testFuzz_totalEqualsTrailingSum(uint32[20] calldata dts, uint64[20] calldata amts) public {
        uint256 n;
        uint256[] memory times = new uint256[](20);
        uint256[] memory amounts = new uint256[](20);
        for (uint256 i; i < 20; ++i) {
            vm.warp(block.timestamp + (dts[i] % 3 days));
            uint256 amount = uint256(amts[i]) + 1;
            h.spend(amount); // 20 < CAPACITY, never full
            times[n] = block.timestamp;
            amounts[n] = amount;
            ++n;
            (uint256 sum,,) = _model(times, amounts, n, block.timestamp);
            assertEq(h.total(), sum);
        }
    }

    function _model(uint256[] memory times, uint256[] memory amounts, uint256 n, uint256 nowTs)
        internal
        pure
        returns (uint256 sum, uint256 distinct, bool lastIsNow)
    {
        uint256 prev = type(uint256).max;
        for (uint256 i; i < n; ++i) {
            if (times[i] + WINDOW > nowTs) {
                sum += amounts[i];
                if (times[i] != prev) ++distinct;
                prev = times[i];
            }
        }
        lastIsNow = n != 0 && times[n - 1] == nowTs;
    }

    function _oldestLive(uint256[] memory times, uint256 n) internal view returns (uint256) {
        for (uint256 i; i < n; ++i) {
            if (times[i] + WINDOW > block.timestamp) return times[i];
        }
        revert("no live entry");
    }
}
