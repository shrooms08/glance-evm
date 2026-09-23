// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {IStockRouter} from "../interfaces/IStockRouter.sol";
import {MarketStatusLib} from "../MarketStatusLib.sol";

/// @title StockDesk
/// @notice TESTNET STAND-IN trading venue. A deterministic, oracle-priced desk, NOT an AMM and not a real market.
/// @dev There is no stock/USDG liquidity on the testnets Glance targets (see docs/CHAIN_NOTES.md), so this desk is the
///      demo venue. It holds its own inventory of USDG and stock tokens, fills every swap at the feed price minus a
///      fixed spread, and reverts when inventory is short. There is no price impact, no LP, and no arbitrage: the
///      price is whatever the configured feed says. The owner seeds and withdraws inventory.
///
///      Pricing (both directions apply the spread once, so a buy-then-sell round trip loses about 2 * spread):
///        buy:  tokensOut = oracleTokens(usdgIn)  * (BPS - spreadBps) / BPS
///        sell: usdgOut   = oracleUsdg(tokensIn)  * (BPS - spreadBps) / BPS
///      where oracleTokens / oracleUsdg are MarketStatusLib's decimal-aware conversions (USDG treated as $1).
contract StockDesk is IStockRouter, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Basis point denominator.
    uint256 public constant BPS = 10_000;
    /// @notice Default spread charged on each fill (0.30%).
    uint16 public constant DEFAULT_SPREAD_BPS = 30;
    /// @notice Largest spread the owner may set (5%).
    uint16 public constant MAX_SPREAD_BPS = 500;
    /// @notice Prices older than this are refused. Matches the vault's CLOSED window so weekend demos still fill.
    uint256 public constant MAX_PRICE_AGE = MarketStatusLib.DEFAULT_CLOSED_MAX_AGE;

    /// @notice The quote currency.
    IERC20 public immutable usdg;
    /// @notice USDG decimals, read at deploy.
    uint8 public immutable usdgDecimals;

    /// @notice Spread charged on each fill, in basis points.
    uint16 public spreadBps;
    /// @notice Price feed for each listed stock token. Zero means not listed.
    mapping(address token => AggregatorV3Interface feed) public feedOf;

    /// @notice Emitted when a stock is listed, re-priced to a new feed, or delisted (feed = 0).
    event FeedSet(address indexed token, address indexed feed);
    /// @notice Emitted when the spread changes.
    event SpreadSet(uint16 spreadBps);
    /// @notice Emitted when the owner adds inventory.
    event InventorySeeded(address indexed token, uint256 amount);
    /// @notice Emitted when the owner removes inventory.
    event InventoryWithdrawn(address indexed token, address indexed to, uint256 amount);
    /// @notice Emitted on every fill.
    event Swapped(
        address indexed trader,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 price,
        address to
    );

    /// @notice The token has no feed on this desk.
    error NotListed(address token);
    /// @notice The feed's last update is older than MAX_PRICE_AGE.
    error StalePrice(address token, uint256 updatedAt);
    /// @notice The desk does not hold enough of the output token to fill the swap.
    error InsufficientInventory(address token, uint256 available, uint256 needed);
    /// @notice The fill is below the caller's minimum.
    error BelowMinOut(uint256 amountOut, uint256 minOut);
    /// @notice The fill rounds down to zero output.
    error ZeroOutput();
    /// @notice Spread above MAX_SPREAD_BPS.
    error SpreadTooHigh(uint16 spreadBps);
    /// @notice Zero address or zero amount.
    error InvalidArgument();

    /// @param usdg_ Quote token.
    /// @param owner_ Desk operator.
    constructor(address usdg_, address owner_) Ownable(owner_) {
        if (usdg_ == address(0)) revert InvalidArgument();
        usdg = IERC20(usdg_);
        usdgDecimals = IERC20Metadata(usdg_).decimals();
        spreadBps = DEFAULT_SPREAD_BPS;
        emit SpreadSet(DEFAULT_SPREAD_BPS);
    }

    // ---------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------

    /// @notice Lists `token` priced off `feed`, or delists it when `feed` is zero.
    /// @param token Stock token.
    /// @param feed USD price feed for one whole token.
    function setFeed(address token, address feed) external onlyOwner {
        if (token == address(0) || token == address(usdg)) revert InvalidArgument();
        feedOf[token] = AggregatorV3Interface(feed);
        emit FeedSet(token, feed);
    }

    /// @notice Sets the spread charged on each fill.
    /// @param spreadBps_ New spread, at most MAX_SPREAD_BPS.
    function setSpread(uint16 spreadBps_) external onlyOwner {
        if (spreadBps_ > MAX_SPREAD_BPS) revert SpreadTooHigh(spreadBps_);
        spreadBps = spreadBps_;
        emit SpreadSet(spreadBps_);
    }

    /// @notice Pulls `amount` of `token` from the owner into inventory. Requires a prior approval.
    /// @param token USDG or a stock token.
    /// @param amount Raw amount.
    function seed(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || amount == 0) revert InvalidArgument();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit InventorySeeded(token, amount);
    }

    /// @notice Sends `amount` of `token` from inventory to `to`.
    /// @param token Any token held by the desk.
    /// @param to Recipient.
    /// @param amount Raw amount.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || to == address(0) || amount == 0) revert InvalidArgument();
        IERC20(token).safeTransfer(to, amount);
        emit InventoryWithdrawn(token, to, amount);
    }

    // ---------------------------------------------------------------------
    // Quotes
    // ---------------------------------------------------------------------

    /// @notice Stock tokens a buy of `usdgIn` would receive right now, after the spread.
    /// @param token Listed stock token.
    /// @param usdgIn Raw USDG in.
    function quoteBuy(address token, uint256 usdgIn) public view returns (uint256 tokensOut) {
        (uint256 price, uint8 priceDecimals) = _price(token);
        uint256 fair = MarketStatusLib.usdgToTokenAmount(
            usdgIn, usdgDecimals, price, priceDecimals, IERC20Metadata(token).decimals()
        );
        return _afterSpread(fair);
    }

    /// @notice USDG a sale of `tokensIn` would receive right now, after the spread.
    /// @param token Listed stock token.
    /// @param tokensIn Raw stock tokens in.
    function quoteSell(address token, uint256 tokensIn) public view returns (uint256 usdgOut) {
        (uint256 price, uint8 priceDecimals) = _price(token);
        uint256 fair = MarketStatusLib.tokenToUsdgAmount(
            tokensIn, IERC20Metadata(token).decimals(), price, priceDecimals, usdgDecimals
        );
        return _afterSpread(fair);
    }

    /// @notice Desk inventory of `token`.
    /// @param token Any token.
    function inventory(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    // ---------------------------------------------------------------------
    // IStockRouter
    // ---------------------------------------------------------------------

    /// @inheritdoc IStockRouter
    function swapUsdgForToken(address token, uint256 usdgIn, uint256 minOut, address to)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (usdgIn == 0 || to == address(0)) revert InvalidArgument();
        out = quoteBuy(token, usdgIn);
        _checkFill(token, out, minOut);
        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        IERC20(token).safeTransfer(to, out);
        emit Swapped(msg.sender, address(usdg), token, usdgIn, out, _lastPrice(token), to);
    }

    /// @inheritdoc IStockRouter
    function swapTokenForUsdg(address token, uint256 tokensIn, uint256 minOut, address to)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (tokensIn == 0 || to == address(0)) revert InvalidArgument();
        out = quoteSell(token, tokensIn);
        _checkFill(address(usdg), out, minOut);
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        usdg.safeTransfer(to, out);
        emit Swapped(msg.sender, token, address(usdg), tokensIn, out, _lastPrice(token), to);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Validated price for a listed token. Rejects unlisted tokens, non-positive prices and stale prices.
    function _price(address token) internal view returns (uint256 price, uint8 priceDecimals) {
        AggregatorV3Interface feed = feedOf[token];
        if (address(feed) == address(0)) revert NotListed(token);
        // Only the validated price and updatedAt are used; the desk applies its own MAX_PRICE_AGE.
        MarketStatusLib.OracleReading memory r =
            MarketStatusLib.read(feed, MarketStatusLib.DEFAULT_OPEN_MAX_AGE, MarketStatusLib.DEFAULT_CLOSED_MAX_AGE);
        if (block.timestamp - r.updatedAt > MAX_PRICE_AGE) revert StalePrice(token, r.updatedAt);
        return (r.price, r.decimals);
    }

    /// @dev Price for the Swapped event; the swap has already validated it.
    function _lastPrice(address token) internal view returns (uint256 price) {
        (price,) = _price(token);
    }

    function _checkFill(address tokenOut, uint256 out, uint256 minOut) internal view {
        if (out == 0) revert ZeroOutput();
        if (out < minOut) revert BelowMinOut(out, minOut);
        uint256 available = IERC20(tokenOut).balanceOf(address(this));
        if (available < out) revert InsufficientInventory(tokenOut, available, out);
    }

    function _afterSpread(uint256 fair) internal view returns (uint256) {
        return Math.mulDiv(fair, BPS - spreadBps, BPS);
    }
}
