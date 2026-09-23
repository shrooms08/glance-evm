// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";

/// @notice Chainlink-style feed with a settable answer and update time, for tests only.
contract MockPriceFeed is AggregatorV3Interface {
    uint8 public immutable override decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
        roundId = 1;
    }

    function setPrice(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
        ++roundId;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    function description() external pure returns (string memory) {
        return "MOCK / USD";
    }

    function version() external pure returns (uint256) {
        return 4;
    }

    function getRoundData(uint80) external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
