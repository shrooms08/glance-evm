// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title MarketStatusLib
/// @notice Reads a Chainlink-style stock price feed and infers whether the underlying market is open.
/// @dev Tokenized-stock feeds stop updating when the exchange is closed. The age of the last update is therefore a
///      proxy for market status, with two thresholds supplied per feed by the caller:
///        age <= openMaxAge   -> OPEN   (feed is updating normally)
///        age <= closedMaxAge -> CLOSED (overnight or weekend: Fri close to Mon open is ~65.5h, plus margin)
///        otherwise           -> STALE  (feed is broken or halted; no trade should be priced off it)
///
///      Heartbeat caveat: this only reads market hours correctly if the feed's heartbeat (the longest it goes without
///      an update while the market is open) is shorter than openMaxAge. Chainlink's Robinhood equity feeds have a 24
///      hour heartbeat and otherwise update on price deviation, so a healthy but quiet feed can be many hours old
///      during trading. With a 1 hour openMaxAge it would read CLOSED most of the day. A mainnet deployment must set
///      both thresholds per feed from that feed's heartbeat, e.g. openMaxAge just above the heartbeat and
///      closedMaxAge above heartbeat + the longest scheduled closure. The defaults below suit a feed that updates at
///      least hourly, such as the testnet stand-ins.
///
///      Pricing convention used throughout:
///        - `price` is the USD value of ONE WHOLE stock token, scaled by 10^priceDecimals.
///        - USDG is treated as exactly 1 USD, so a raw USDG amount `u` is worth u / 10^usdgDecimals USD.
///        - A raw stock amount `t` is t / 10^tokenDecimals whole tokens.
library MarketStatusLib {
    /// @notice Market status inferred from oracle freshness.
    enum MarketState {
        OPEN,
        CLOSED,
        STALE
    }

    /// @notice A validated oracle reading.
    struct OracleReading {
        uint256 price;
        uint8 decimals;
        uint256 updatedAt;
        MarketState state;
    }

    /// @notice Default maximum age for OPEN, for feeds that update at least hourly.
    uint32 internal constant DEFAULT_OPEN_MAX_AGE = 1 hours;
    /// @notice Default maximum age for CLOSED rather than STALE: a weekend (~65.5h) plus margin.
    uint32 internal constant DEFAULT_CLOSED_MAX_AGE = 80 hours;

    /// @notice The feed reported a zero or negative price.
    error InvalidOraclePrice(int256 answer);
    /// @notice The feed reported an update time in the future.
    error OracleTimestampInFuture(uint256 updatedAt);

    /// @notice Reads the latest round of `feed`, validates the price and classifies market status.
    /// @dev Reverts on a non-positive answer or a future timestamp. A STALE reading is returned, not reverted on,
    ///      so callers can decide how to handle it (the vault refuses to trade).
    /// @param feed The price feed.
    /// @param openMaxAge Maximum age of the last update for OPEN. Must exceed the feed's market-hours heartbeat.
    /// @param closedMaxAge Maximum age for CLOSED; anything older is STALE. Must be greater than openMaxAge.
    function read(AggregatorV3Interface feed, uint256 openMaxAge, uint256 closedMaxAge)
        internal
        view
        returns (OracleReading memory reading)
    {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert InvalidOraclePrice(answer);
        if (updatedAt > block.timestamp) revert OracleTimestampInFuture(updatedAt);

        // Safe: answer > 0 was checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        reading.price = uint256(answer);
        reading.decimals = feed.decimals();
        reading.updatedAt = updatedAt;
        reading.state = classify(updatedAt, block.timestamp, openMaxAge, closedMaxAge);
    }

    /// @notice Classifies market status from the age of the last oracle update.
    /// @param updatedAt Timestamp of the last oracle update. Must not be after `nowTs`.
    /// @param nowTs Current timestamp.
    /// @param openMaxAge Maximum age for OPEN.
    /// @param closedMaxAge Maximum age for CLOSED; anything older is STALE.
    function classify(uint256 updatedAt, uint256 nowTs, uint256 openMaxAge, uint256 closedMaxAge)
        internal
        pure
        returns (MarketState)
    {
        uint256 age = nowTs - updatedAt;
        if (age <= openMaxAge) return MarketState.OPEN;
        if (age <= closedMaxAge) return MarketState.CLOSED;
        return MarketState.STALE;
    }

    /// @notice Converts a raw USDG amount into the oracle-implied raw stock token amount. Rounds down.
    /// @dev Derivation:
    ///        usd          = usdgAmount / 10^ud
    ///        wholeTokens  = usd / (price / 10^pd)          = usdgAmount * 10^pd / (price * 10^ud)
    ///        rawTokens    = wholeTokens * 10^td            = usdgAmount * 10^(pd + td) / (price * 10^ud)
    ///      To keep intermediates small we cancel the common power of ten first:
    ///        if pd + td >= ud: rawTokens = usdgAmount * 10^(pd + td - ud) / price
    ///        else:             rawTokens = usdgAmount / (price * 10^(ud - pd - td))
    ///      Math.mulDiv computes the product at 512-bit precision, so the numerator cannot overflow.
    ///      Example: 100 USDG (6 dp) at $200.00000000 (8 dp) into an 18 dp token:
    ///        100e6 * 10^(8 + 18 - 6) / 200e8 = 5e17 = 0.5 tokens.
    /// @param usdgAmount Raw USDG amount.
    /// @param usdgDecimals Decimals of USDG (ud).
    /// @param price Oracle price of one whole token, in USD scaled by 10^priceDecimals.
    /// @param priceDecimals Decimals of the oracle answer (pd).
    /// @param tokenDecimals Decimals of the stock token (td).
    function usdgToTokenAmount(
        uint256 usdgAmount,
        uint8 usdgDecimals,
        uint256 price,
        uint8 priceDecimals,
        uint8 tokenDecimals
    ) internal pure returns (uint256) {
        uint256 up = uint256(priceDecimals) + tokenDecimals;
        if (up >= usdgDecimals) {
            return Math.mulDiv(usdgAmount, 10 ** (up - usdgDecimals), price);
        }
        return usdgAmount / (price * 10 ** (usdgDecimals - up));
    }

    /// @notice Converts a raw stock token amount into the oracle-implied raw USDG amount. Rounds down.
    /// @dev Inverse of usdgToTokenAmount:
    ///        usd        = (tokenAmount / 10^td) * (price / 10^pd)
    ///        rawUsdg    = usd * 10^ud = tokenAmount * price * 10^ud / 10^(pd + td)
    ///      Cancelling the common power of ten:
    ///        if pd + td >= ud: rawUsdg = tokenAmount * price / 10^(pd + td - ud)
    ///        else:             rawUsdg = tokenAmount * price * 10^(ud - pd - td)
    ///      Example: 0.5 tokens (18 dp) at $200.00000000 (8 dp) into 6 dp USDG:
    ///        5e17 * 200e8 / 10^(8 + 18 - 6) = 100e6 = 100 USDG.
    /// @param tokenAmount Raw stock token amount.
    /// @param tokenDecimals Decimals of the stock token (td).
    /// @param price Oracle price of one whole token, in USD scaled by 10^priceDecimals.
    /// @param priceDecimals Decimals of the oracle answer (pd).
    /// @param usdgDecimals Decimals of USDG (ud).
    function tokenToUsdgAmount(
        uint256 tokenAmount,
        uint8 tokenDecimals,
        uint256 price,
        uint8 priceDecimals,
        uint8 usdgDecimals
    ) internal pure returns (uint256) {
        uint256 down = uint256(priceDecimals) + tokenDecimals;
        if (down >= usdgDecimals) {
            return Math.mulDiv(tokenAmount, price, 10 ** (down - usdgDecimals));
        }
        return tokenAmount * price * 10 ** (usdgDecimals - down);
    }
}
