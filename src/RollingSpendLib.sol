// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title RollingSpendLib
/// @notice Tracks spend over a rolling 24 hour window using a fixed-size ring buffer of (timestamp, amount) entries.
/// @dev Invariants maintained by this library:
///        - Entries are stored oldest first starting at `head`, `count` entries long, wrapping modulo CAPACITY.
///        - Entry timestamps are non-decreasing from oldest to newest (block timestamps never go backwards).
///        - `total` equals the sum of the amounts of the `count` live entries.
///      An entry is "in the window" at time `now` iff `entry.timestamp + WINDOW > now`, i.e. it happened within the
///      last 24 hours. Every loop is bounded by CAPACITY.
///
///      Several spends in the same block are merged into one entry, so the buffer limits the number of distinct
///      spending timestamps per 24 hours, not the number of trades. When all CAPACITY slots hold in-window
///      entries, `record` reverts rather than overwriting live data, since overwriting would undercount spend.
library RollingSpendLib {
    /// @notice Length of the rolling window.
    uint256 internal constant WINDOW = 24 hours;
    /// @notice Number of entries the ring buffer can hold.
    uint256 internal constant CAPACITY = 32;

    /// @notice A single spend record, packed into one storage slot.
    struct Entry {
        uint64 timestamp;
        uint192 amount;
    }

    /// @notice Ring buffer state.
    struct Window {
        Entry[CAPACITY] entries;
        uint256 head;
        uint256 count;
        uint256 total;
    }

    /// @notice Every slot holds a spend from the last 24 hours. `nextSlotFreesAt` is when the oldest one expires.
    error SpendBufferFull(uint256 nextSlotFreesAt);

    /// @notice Drops every entry that has left the window and updates the running total.
    function prune(Window storage w, uint256 nowTs) internal {
        uint256 head = w.head;
        uint256 count = w.count;
        uint256 total = w.total;
        // Bounded: at most CAPACITY iterations since `count <= CAPACITY`.
        while (count != 0) {
            Entry storage oldest = w.entries[head];
            if (uint256(oldest.timestamp) + WINDOW > nowTs) break;
            total -= oldest.amount;
            delete w.entries[head];
            head = (head + 1) % CAPACITY;
            --count;
        }
        w.head = head;
        w.count = count;
        w.total = total;
    }

    /// @notice Appends a spend at `nowTs`. Call `prune` first so expired entries free their slots.
    /// @dev Merges into the newest entry when it has the same timestamp. Reverts with SpendBufferFull when a new
    ///      slot is needed and none is free.
    function record(Window storage w, uint256 amount, uint256 nowTs) internal {
        uint192 amount192 = SafeCast.toUint192(amount);
        uint256 count = w.count;

        if (count != 0) {
            Entry storage newest = w.entries[(w.head + count - 1) % CAPACITY];
            if (newest.timestamp == nowTs) {
                newest.amount += amount192;
                w.total += amount;
                return;
            }
        }

        if (count == CAPACITY) revert SpendBufferFull(uint256(w.entries[w.head].timestamp) + WINDOW);

        w.entries[(w.head + count) % CAPACITY] = Entry({timestamp: SafeCast.toUint64(nowTs), amount: amount192});
        w.count = count + 1;
        w.total += amount;
    }

    /// @notice Sum of spend within the window at `nowTs`, without mutating state.
    function spentInWindow(Window storage w, uint256 nowTs) internal view returns (uint256 spent) {
        uint256 head = w.head;
        uint256 count = w.count;
        // Entries are ordered oldest first, so skip the expired prefix and sum the rest. Bounded by CAPACITY.
        for (uint256 i; i < count; ++i) {
            Entry storage e = w.entries[(head + i) % CAPACITY];
            if (uint256(e.timestamp) + WINDOW > nowTs) spent += e.amount;
        }
    }
}
