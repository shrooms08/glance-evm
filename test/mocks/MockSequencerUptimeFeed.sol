// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";

/// @notice Chainlink L2 sequencer uptime feed: answer 0 = up, 1 = down; startedAt = when the status last changed.
contract MockSequencerUptimeFeed is AggregatorV3Interface {
    int256 public answer;
    uint256 public startedAt;

    constructor() {
        startedAt = block.timestamp;
    }

    /// @notice Sets the status and when it changed.
    function setStatus(bool down, uint256 startedAt_) external {
        answer = down ? int256(1) : int256(0);
        startedAt = startedAt_;
    }

    function decimals() external pure returns (uint8) {
        return 0;
    }

    function description() external pure returns (string memory) {
        return "L2 Sequencer Uptime Status Feed";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80) external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, startedAt, 1);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, startedAt, 1);
    }
}
