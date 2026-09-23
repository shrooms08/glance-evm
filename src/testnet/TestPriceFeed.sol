// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @title TestPriceFeed
/// @notice TESTNET STAND-IN for a Chainlink price feed. The owner sets the price and the update time by hand.
/// @dev Used where no Chainlink feed exists (Robinhood Chain testnet, Arbitrum Sepolia) and to drive the
///      "simulate weekend" demo by back-dating `updatedAt`. `description()` always starts with "TEST FEED" and
///      `isTestFeed()` returns true, so a stand-in can never be mistaken for a real feed in a UI or console.
contract TestPriceFeed is AggregatorV3Interface, Ownable {
    /// @notice Prefix of every description, marking the feed as a stand-in.
    string public constant TEST_PREFIX = "TEST FEED (Glance testnet stand-in): ";

    /// @inheritdoc AggregatorV3Interface
    uint8 public immutable override decimals;

    string private _pair;
    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _roundId;

    /// @notice Emitted when the price or update time changes.
    event PriceSet(uint80 indexed roundId, int256 answer, uint256 updatedAt);

    /// @notice The update time is in the future.
    error UpdatedAtInFuture(uint256 updatedAt);

    /// @param decimals_ Decimals of the answer (8 for Chainlink USD equity feeds).
    /// @param pair_ Human readable pair, e.g. "TSLA / USD".
    /// @param answer_ Initial answer.
    /// @param owner_ Address allowed to update the feed.
    constructor(uint8 decimals_, string memory pair_, int256 answer_, address owner_) Ownable(owner_) {
        decimals = decimals_;
        _pair = pair_;
        _setRound(answer_, block.timestamp);
    }

    /// @notice Always true. Lets UIs and scripts label this feed as a stand-in.
    function isTestFeed() external pure returns (bool) {
        return true;
    }

    /// @notice Sets a new price, timestamped now.
    /// @param answer_ New answer, scaled by `decimals`.
    function setPrice(int256 answer_) external onlyOwner {
        _setRound(answer_, block.timestamp);
    }

    /// @notice Sets a new price with an explicit update time, e.g. 30 hours ago to simulate a closed market.
    /// @param answer_ New answer, scaled by `decimals`.
    /// @param updatedAt_ Update time. Must not be in the future.
    function setRoundData(int256 answer_, uint256 updatedAt_) external onlyOwner {
        if (updatedAt_ > block.timestamp) revert UpdatedAtInFuture(updatedAt_);
        _setRound(answer_, updatedAt_);
    }

    /// @notice Back-dates or refreshes the current price's update time without changing the price.
    /// @param updatedAt_ Update time. Must not be in the future.
    function setUpdatedAt(uint256 updatedAt_) external onlyOwner {
        if (updatedAt_ > block.timestamp) revert UpdatedAtInFuture(updatedAt_);
        _setRound(_answer, updatedAt_);
    }

    /// @inheritdoc AggregatorV3Interface
    function description() external view returns (string memory) {
        return string.concat(TEST_PREFIX, _pair);
    }

    /// @inheritdoc AggregatorV3Interface
    function version() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc AggregatorV3Interface
    /// @dev Only the latest round is stored; any round id returns it.
    function getRoundData(uint80) external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    /// @inheritdoc AggregatorV3Interface
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function _setRound(int256 answer_, uint256 updatedAt_) private {
        _answer = answer_;
        _updatedAt = updatedAt_;
        uint80 roundId = ++_roundId;
        emit PriceSet(roundId, answer_, updatedAt_);
    }
}
