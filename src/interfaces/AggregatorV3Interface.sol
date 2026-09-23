// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title AggregatorV3Interface
/// @notice Minimal copy of Chainlink's AggregatorV3Interface, vendored to avoid pulling the full Chainlink package.
interface AggregatorV3Interface {
    /// @notice Number of decimals the answer is scaled by.
    function decimals() external view returns (uint8);

    /// @notice Human readable description of the feed.
    function description() external view returns (string memory);

    /// @notice Aggregator version.
    function version() external view returns (uint256);

    /// @notice Data for a specific round.
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    /// @notice Data for the latest round.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
