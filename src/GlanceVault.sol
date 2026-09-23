// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IStockRouter} from "./interfaces/IStockRouter.sol";
import {MarketStatusLib} from "./MarketStatusLib.sol";
import {RollingSpendLib} from "./RollingSpendLib.sol";

/// @title GlanceVault
/// @notice Holds one owner's USDG and tokenized stocks, and lets a time-limited agent key trade them within limits
///         enforced on chain.
/// @dev Security model and assumptions:
///      - The agent key lives on a hot server and must be assumed compromised. With it, an attacker can only buy and
///        sell approved tokens through approved routers, at a price no worse than the oracle minus the slippage
///        bound, within the per-trade cap and the rolling 24h buy and sell caps, until the key expires.
///      - A compromised agent key can never withdraw funds, change limits, approve tokens or routers, pause or
///        unpause, or extend its own expiry. Every swap delivers its output back to this vault.
///      - USDG is assumed to be worth exactly one US dollar. There is no USDG price feed.
///      - Each direction's rolling window is a 32-entry ring buffer, so the agent can trade at no more than 32
///        distinct timestamps per 24 hours per direction. Trades in the same block share one entry.
///      - On chains with a Chainlink L2 sequencer uptime feed (Arbitrum One, and Orbit chains that publish one), the
///        owner must configure it with `setSequencerUptimeFeed`. It is left unset where no such feed exists.
contract GlanceVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using MarketStatusLib for AggregatorV3Interface;
    using RollingSpendLib for RollingSpendLib.Window;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Per-token configuration.
    struct TokenConfig {
        bool approved;
        address priceFeed;
    }

    /// @notice Trade direction. Buys and sells have separate rolling windows and daily caps.
    enum Side {
        BUY,
        SELL
    }

    /// @notice The caps and oracle data a trade was checked against, shared by `buy` and `sell`.
    /// @dev `dailyCap` is the effective daily cap for the trade's side.
    struct TradeContext {
        MarketStatusLib.OracleReading oracle;
        uint8 tokenDecimals;
        uint256 perTradeCap;
        uint256 dailyCap;
        uint256 slippageBps;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Basis point denominator (100%).
    uint256 public constant BPS = 10_000;
    /// @notice Upper bound the owner may set for `maxSlippageBps` (10%).
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000;
    /// @notice Allowed slippage is divided by this factor while the market is closed.
    uint256 public constant CLOSED_SLIPPAGE_DIVISOR = 2;
    /// @notice Longest lifetime an agent key can be granted in one `setAgent` call.
    uint256 public constant MAX_AGENT_TTL = 30 days;
    /// @notice How long after the L2 sequencer comes back up before feed data is trusted again.
    uint256 public constant SEQUENCER_GRACE_PERIOD = 3600;
    /// @notice Sequencer uptime feed answer meaning "up". Any other answer means down.
    int256 internal constant SEQUENCER_UP = 0;

    /// @notice Default per-trade cap, in whole USDG (scaled by USDG decimals at deploy).
    uint256 public constant DEFAULT_PER_BUY_CAP_WHOLE = 100;
    /// @notice Default rolling 24h cap for buys and for sells, in whole USDG (scaled by USDG decimals at deploy).
    uint256 public constant DEFAULT_DAILY_CAP_WHOLE = 500;
    /// @notice Default maximum slippage versus the oracle (1%).
    uint16 public constant DEFAULT_MAX_SLIPPAGE_BPS = 100;
    /// @notice Default fraction of the caps that applies while the market is closed (25%).
    uint16 public constant DEFAULT_WEEKEND_CAP_BPS = 2_500;

    // ---------------------------------------------------------------------
    // Immutable state
    // ---------------------------------------------------------------------

    /// @notice The vault owner. The only address that can move funds out or change configuration.
    address public immutable owner;
    /// @notice The USDG stablecoin, treated as 1 USD.
    IERC20 public immutable usdg;
    /// @notice USDG decimals, read from the token at deploy.
    uint8 public immutable usdgDecimals;

    // ---------------------------------------------------------------------
    // Mutable state
    // ---------------------------------------------------------------------

    /// @notice The current agent key, or address(0) if none.
    address public agent;
    /// @notice The agent may act while `block.timestamp < agentExpiry`.
    uint64 public agentExpiry;
    /// @notice Maximum slippage versus the oracle price, in basis points.
    uint16 public maxSlippageBps;
    /// @notice Fraction of the caps that applies while the market is closed, in basis points.
    uint16 public weekendCapBps;
    /// @notice When true, all agent trading is halted.
    bool public paused;

    /// @notice Maximum USDG value of a single agent trade while the market is open.
    uint256 public perBuyCap;
    /// @notice Maximum USDG spent by agent buys in any rolling 24 hour window while the market is open.
    uint256 public dailyCap;
    /// @notice Maximum oracle USDG value of agent sells in any rolling 24 hour window while the market is open.
    uint256 public dailySellCap;

    /// @notice Chainlink L2 sequencer uptime feed, or address(0) to disable the check. Leave unset on chains that
    ///         do not publish one.
    AggregatorV3Interface public sequencerUptimeFeed;

    /// @notice Per-token approval and price feed.
    mapping(address token => TokenConfig) public tokenConfig;
    /// @notice Routers the agent may trade through.
    mapping(address router => bool) public approvedRouters;

    /// @dev Rolling 24h record of USDG spent by agent buys.
    RollingSpendLib.Window internal _buyWindow;
    /// @dev Rolling 24h record of the oracle USDG value of agent sells.
    RollingSpendLib.Window internal _sellWindow;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted when the owner deposits USDG.
    event Deposited(uint256 amount);
    /// @notice Emitted when the owner withdraws a token.
    event Withdrawn(address indexed token, uint256 amount);
    /// @notice Emitted when the agent key or its expiry changes. A revoke emits (address(0), 0).
    event AgentSet(address indexed agent, uint64 expiry);
    /// @notice Emitted when limits change.
    event LimitsSet(
        uint256 perBuyCap, uint256 dailyCap, uint256 dailySellCap, uint16 maxSlippageBps, uint16 weekendCapBps
    );
    /// @notice Emitted when the sequencer uptime feed changes. address(0) means the check is disabled.
    event SequencerUptimeFeedSet(address indexed feed);
    /// @notice Emitted when the pause flag changes.
    event PausedSet(bool paused);
    /// @notice Emitted when a token's approval or price feed changes.
    event TokenApprovalSet(address indexed token, address indexed priceFeed, bool approved);
    /// @notice Emitted when a router's approval changes.
    event RouterApprovalSet(address indexed router, bool approved);
    /// @notice Emitted on every successful agent buy.
    event Bought(
        address indexed token,
        address indexed router,
        uint256 usdgIn,
        uint256 tokensOut,
        uint256 oraclePrice,
        MarketStatusLib.MarketState marketState,
        uint256 effectivePerTradeCap,
        uint256 effectiveDailyCap
    );
    /// @notice Emitted on every successful agent sell. `notional` is the oracle USDG value counted against the caps,
    ///         and `effectiveDailyCap` is the effective daily sell cap.
    event Sold(
        address indexed token,
        address indexed router,
        uint256 tokensIn,
        uint256 usdgOut,
        uint256 notional,
        uint256 oraclePrice,
        MarketStatusLib.MarketState marketState,
        uint256 effectivePerTradeCap,
        uint256 effectiveDailyCap
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    /// @notice Caller is not the owner.
    error NotOwner();
    /// @notice A required address argument was zero.
    error ZeroAddress();
    /// @notice A required amount argument was zero.
    error ZeroAmount();
    /// @notice Agent expiry is in the past or further out than MAX_AGENT_TTL.
    error InvalidAgentExpiry(uint64 expiry);
    /// @notice Limits are inconsistent or out of range.
    error InvalidLimits();
    /// @notice Token configuration is invalid (e.g. approving without a feed, or configuring USDG itself).
    error InvalidTokenConfig();
    /// @notice Agent trading is paused.
    error VaultPaused();
    /// @notice Caller is not the current agent.
    error NotAgent(address caller);
    /// @notice The agent key has expired.
    error AgentExpired(uint64 expiry);
    /// @notice Token is not approved for trading.
    error TokenNotApproved(address token);
    /// @notice Token has no price feed configured.
    error MissingPriceFeed(address token);
    /// @notice Router is not approved.
    error RouterNotApproved(address router);
    /// @notice The oracle has not updated within the CLOSED window; the price cannot be trusted.
    error OracleStale(uint256 updatedAt);
    /// @notice Trade notional exceeds the effective per-trade cap.
    error ExceedsPerTradeCap(uint256 notional, uint256 cap);
    /// @notice A buy would push the rolling 24h buy total over the effective daily cap.
    error ExceedsDailyCap(uint256 spentInWindow, uint256 notional, uint256 cap);
    /// @notice A sell would push the rolling 24h sell total over the effective daily sell cap.
    error ExceedsDailySellCap(uint256 soldInWindow, uint256 notional, uint256 cap);
    /// @notice The L2 sequencer uptime feed reports the sequencer as down, or has no valid status yet.
    error SequencerDown();
    /// @notice The L2 sequencer came back up less than SEQUENCER_GRACE_PERIOD ago.
    error SequencerGracePeriod(uint256 trustedFrom);
    /// @notice The agent's minimum output is below the oracle-derived floor.
    error SlippageTooHigh(uint256 minOut, uint256 floor);
    /// @notice The router delivered less than the minimum output.
    error InsufficientOutput(uint256 received, uint256 minOut);
    /// @notice The vault does not hold enough of the input token.
    error InsufficientBalance(uint256 balance, uint256 needed);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param owner_ The vault owner.
    /// @param usdg_ The USDG token. Its decimals are read here and used to scale the default caps.
    constructor(address owner_, address usdg_) {
        if (owner_ == address(0) || usdg_ == address(0)) revert ZeroAddress();
        owner = owner_;
        usdg = IERC20(usdg_);
        uint8 decimals = IERC20Metadata(usdg_).decimals();
        usdgDecimals = decimals;

        uint256 unit = 10 ** decimals;
        perBuyCap = DEFAULT_PER_BUY_CAP_WHOLE * unit;
        dailyCap = DEFAULT_DAILY_CAP_WHOLE * unit;
        dailySellCap = DEFAULT_DAILY_CAP_WHOLE * unit;
        maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS;
        weekendCapBps = DEFAULT_WEEKEND_CAP_BPS;
        emit LimitsSet(perBuyCap, dailyCap, dailySellCap, DEFAULT_MAX_SLIPPAGE_BPS, DEFAULT_WEEKEND_CAP_BPS);
    }

    // ---------------------------------------------------------------------
    // Owner functions
    // ---------------------------------------------------------------------

    /// @notice Pulls `amount` USDG from the owner into the vault. Requires a prior approval.
    /// @param amount Raw USDG amount.
    function deposit(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(amount);
    }

    /// @notice Sends `amount` of `token` from the vault to the owner. Works while paused.
    /// @param token Any ERC-20 held by the vault, including USDG.
    /// @param amount Raw token amount.
    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(owner, amount);
        emit Withdrawn(token, amount);
    }

    /// @notice Sets the agent key and when it expires.
    /// @param agent_ The agent address.
    /// @param expiry Unix timestamp after which the agent can no longer trade. At most MAX_AGENT_TTL from now.
    function setAgent(address agent_, uint64 expiry) external onlyOwner {
        if (agent_ == address(0)) revert ZeroAddress();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_AGENT_TTL) revert InvalidAgentExpiry(expiry);
        agent = agent_;
        agentExpiry = expiry;
        emit AgentSet(agent_, expiry);
    }

    /// @notice Removes the agent key immediately.
    function revokeAgent() external onlyOwner {
        agent = address(0);
        agentExpiry = 0;
        emit AgentSet(address(0), 0);
    }

    /// @notice Updates the trading limits.
    /// @param perBuyCap_ Maximum USDG value of one trade, buy or sell (raw USDG units). Must be non-zero and no
    ///        larger than either daily cap.
    /// @param dailyCap_ Maximum USDG spent by buys in any rolling 24h window (raw USDG units).
    /// @param dailySellCap_ Maximum oracle USDG value of sells in any rolling 24h window (raw USDG units).
    /// @param maxSlippageBps_ Maximum slippage versus the oracle, at most MAX_SLIPPAGE_BPS.
    /// @param weekendCapBps_ Fraction of the caps that applies while the market is closed, at most BPS.
    function setLimits(
        uint256 perBuyCap_,
        uint256 dailyCap_,
        uint256 dailySellCap_,
        uint16 maxSlippageBps_,
        uint16 weekendCapBps_
    ) external onlyOwner {
        if (
            perBuyCap_ == 0 || perBuyCap_ > dailyCap_ || perBuyCap_ > dailySellCap_
                || maxSlippageBps_ > MAX_SLIPPAGE_BPS || weekendCapBps_ > BPS
        ) revert InvalidLimits();
        perBuyCap = perBuyCap_;
        dailyCap = dailyCap_;
        dailySellCap = dailySellCap_;
        maxSlippageBps = maxSlippageBps_;
        weekendCapBps = weekendCapBps_;
        emit LimitsSet(perBuyCap_, dailyCap_, dailySellCap_, maxSlippageBps_, weekendCapBps_);
    }

    /// @notice Pauses or unpauses agent trading. Owner withdrawals are unaffected.
    /// @param paused_ New pause flag.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Approves or unapproves a stock token and sets its price feed.
    /// @param token The stock token. Cannot be USDG.
    /// @param priceFeed Chainlink-style USD feed for one whole token. Required when approving.
    /// @param approved Whether the agent may trade this token.
    function setTokenApproval(address token, address priceFeed, bool approved) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (token == address(usdg) || (approved && priceFeed == address(0))) revert InvalidTokenConfig();
        tokenConfig[token] = TokenConfig({approved: approved, priceFeed: priceFeed});
        emit TokenApprovalSet(token, priceFeed, approved);
    }

    /// @notice Sets or clears the Chainlink L2 sequencer uptime feed.
    /// @dev Configure this on chains that publish a sequencer uptime feed. Pass address(0) on chains without one;
    ///      the check is then skipped.
    /// @param feed The uptime feed, or address(0) to disable the check.
    function setSequencerUptimeFeed(address feed) external onlyOwner {
        sequencerUptimeFeed = AggregatorV3Interface(feed);
        emit SequencerUptimeFeedSet(feed);
    }

    /// @notice Approves or unapproves a router.
    /// @param router The router address.
    /// @param approved Whether the agent may trade through this router.
    function setRouterApproval(address router, bool approved) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        approvedRouters[router] = approved;
        emit RouterApprovalSet(router, approved);
    }

    // ---------------------------------------------------------------------
    // Agent functions
    // ---------------------------------------------------------------------

    /// @notice Buys `token` with exactly `usdgIn` USDG through `router`. Only callable by the agent.
    /// @dev Checks run in a fixed order: pause, agent, token, router, oracle, per-trade cap, daily cap, slippage
    ///      floor, then the post-swap balance delta.
    /// @param token Approved stock token to buy.
    /// @param router Approved router to swap through.
    /// @param usdgIn Exact USDG to spend (raw units).
    /// @param minTokensOut Minimum stock tokens to receive. Must be at least the oracle floor.
    /// @return tokensOut Stock tokens received, measured by balance delta.
    function buy(address token, address router, uint256 usdgIn, uint256 minTokensOut)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        TradeContext memory ctx = _checkAndLoad(token, router, Side.BUY);

        // 6-7. Caps and rolling buy window. For a buy, the notional is the USDG spent.
        _checkCaps(ctx, Side.BUY, usdgIn);

        // 8. The agent's minimum must not be worse than the oracle price minus the allowed slippage.
        uint256 expectedOut = MarketStatusLib.usdgToTokenAmount(
            usdgIn, usdgDecimals, ctx.oracle.price, ctx.oracle.decimals, ctx.tokenDecimals
        );
        uint256 floor = _applySlippage(expectedOut, ctx.slippageBps);
        if (minTokensOut < floor) revert SlippageTooHigh(minTokensOut, floor);

        uint256 usdgBalance = usdg.balanceOf(address(this));
        if (usdgBalance < usdgIn) revert InsufficientBalance(usdgBalance, usdgIn);

        // Effects: record the spend before any external call.
        _buyWindow.record(usdgIn, block.timestamp);

        // Interactions.
        IERC20 stock = IERC20(token);
        uint256 before = stock.balanceOf(address(this));
        usdg.forceApprove(router, usdgIn);
        IStockRouter(router).swapUsdgForToken(token, usdgIn, minTokensOut, address(this));
        usdg.forceApprove(router, 0);

        // 9. Trust the balance delta, not the router's return value.
        tokensOut = stock.balanceOf(address(this)) - before;
        if (tokensOut < minTokensOut) revert InsufficientOutput(tokensOut, minTokensOut);

        emit Bought(token, router, usdgIn, tokensOut, ctx.oracle.price, ctx.oracle.state, ctx.perTradeCap, ctx.dailyCap);
    }

    /// @notice Sells exactly `tokensIn` of `token` for USDG through `router`. Only callable by the agent.
    /// @dev Same checks as `buy`. The trade's notional is its oracle USDG value; it is bounded by the per-trade cap
    ///      and counts against the separate rolling sell window.
    /// @param token Approved stock token to sell.
    /// @param router Approved router to swap through.
    /// @param tokensIn Exact stock tokens to sell (raw units).
    /// @param minUsdgOut Minimum USDG to receive. Must be at least the oracle floor.
    /// @return usdgOut USDG received, measured by balance delta.
    function sell(address token, address router, uint256 tokensIn, uint256 minUsdgOut)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        TradeContext memory ctx = _checkAndLoad(token, router, Side.SELL);

        // 6-7. Caps, measured on the oracle value of the tokens sold. Sells use their own rolling window, separate
        // from buys, so a day of buying never blocks selling. This is safe because sale proceeds stay in the vault
        // and only the owner can withdraw them.
        uint256 notional = MarketStatusLib.tokenToUsdgAmount(
            tokensIn, ctx.tokenDecimals, ctx.oracle.price, ctx.oracle.decimals, usdgDecimals
        );
        _checkCaps(ctx, Side.SELL, notional);

        // 8. Slippage floor. The oracle value is already the expected USDG output.
        uint256 floor = _applySlippage(notional, ctx.slippageBps);
        if (minUsdgOut < floor) revert SlippageTooHigh(minUsdgOut, floor);

        IERC20 stock = IERC20(token);
        uint256 stockBalance = stock.balanceOf(address(this));
        if (stockBalance < tokensIn) revert InsufficientBalance(stockBalance, tokensIn);

        // Effects, then interactions.
        _sellWindow.record(notional, block.timestamp);

        uint256 before = usdg.balanceOf(address(this));
        stock.forceApprove(router, tokensIn);
        IStockRouter(router).swapTokenForUsdg(token, tokensIn, minUsdgOut, address(this));
        stock.forceApprove(router, 0);

        // 9. Post-swap balance delta.
        usdgOut = usdg.balanceOf(address(this)) - before;
        if (usdgOut < minUsdgOut) revert InsufficientOutput(usdgOut, minUsdgOut);

        emit Sold(
            token,
            router,
            tokensIn,
            usdgOut,
            notional,
            ctx.oracle.price,
            ctx.oracle.state,
            ctx.perTradeCap,
            ctx.dailyCap
        );
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice USDG spent by agent buys in the last 24 hours.
    function spentInWindow() external view returns (uint256) {
        return _buyWindow.spentInWindow(block.timestamp);
    }

    /// @notice Oracle USDG value of agent sells in the last 24 hours.
    function soldInWindow() external view returns (uint256) {
        return _sellWindow.spentInWindow(block.timestamp);
    }

    /// @notice The caps that apply in a given market state.
    /// @param state Market state to evaluate.
    /// @return perTradeCap Effective per-trade cap.
    /// @return dailyBuyCap Effective rolling 24h buy cap.
    /// @return dailySellCap_ Effective rolling 24h sell cap.
    function effectiveCaps(MarketStatusLib.MarketState state)
        public
        view
        returns (uint256 perTradeCap, uint256 dailyBuyCap, uint256 dailySellCap_)
    {
        if (state == MarketStatusLib.MarketState.OPEN) return (perBuyCap, dailyCap, dailySellCap);
        return (
            Math.mulDiv(perBuyCap, weekendCapBps, BPS),
            Math.mulDiv(dailyCap, weekendCapBps, BPS),
            Math.mulDiv(dailySellCap, weekendCapBps, BPS)
        );
    }

    /// @notice Whether `account` is currently an active agent.
    /// @param account Address to check.
    function isActiveAgent(address account) external view returns (bool) {
        return account != address(0) && account == agent && block.timestamp < agentExpiry;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Checks 1-5: pause, agent, token, router, oracle (sequencer uptime, then price feed). Returns the oracle
    ///      reading and the effective limits for `side`.
    function _checkAndLoad(address token, address router, Side side) internal view returns (TradeContext memory ctx) {
        // 1. Pause.
        if (paused) revert VaultPaused();

        // 2. Agent identity and expiry. A revoked agent is address(0), which no caller can be.
        address agent_ = agent;
        if (agent_ == address(0) || msg.sender != agent_) revert NotAgent(msg.sender);
        if (block.timestamp >= agentExpiry) revert AgentExpired(agentExpiry);

        // 3. Token approval and feed.
        TokenConfig memory cfg = tokenConfig[token];
        if (!cfg.approved) revert TokenNotApproved(token);
        if (cfg.priceFeed == address(0)) revert MissingPriceFeed(token);

        // 4. Router approval.
        if (!approvedRouters[router]) revert RouterNotApproved(router);

        // 5. Oracle: sequencer uptime, then validated price and freshness. STALE refuses the trade.
        _checkSequencer();
        ctx.oracle = AggregatorV3Interface(cfg.priceFeed).read();
        if (ctx.oracle.state == MarketStatusLib.MarketState.STALE) revert OracleStale(ctx.oracle.updatedAt);

        ctx.tokenDecimals = IERC20Metadata(token).decimals();
        (uint256 perTradeCap, uint256 dailyBuyCap, uint256 dailySellCap_) = effectiveCaps(ctx.oracle.state);
        ctx.perTradeCap = perTradeCap;
        ctx.dailyCap = side == Side.BUY ? dailyBuyCap : dailySellCap_;
        ctx.slippageBps = ctx.oracle.state == MarketStatusLib.MarketState.OPEN
            ? maxSlippageBps
            : maxSlippageBps / CLOSED_SLIPPAGE_DIVISOR;
    }

    /// @dev Checks 6-7. Pruning expired window entries is the only state it touches; the new spend is recorded by
    ///      the caller once every check has passed.
    function _checkCaps(TradeContext memory ctx, Side side, uint256 notional) internal {
        if (notional == 0) revert ZeroAmount();
        // 6. Per-trade cap.
        if (notional > ctx.perTradeCap) revert ExceedsPerTradeCap(notional, ctx.perTradeCap);
        // 7. Rolling 24h cap for this side.
        RollingSpendLib.Window storage window = side == Side.BUY ? _buyWindow : _sellWindow;
        window.prune(block.timestamp);
        uint256 used = window.total;
        if (used + notional > ctx.dailyCap) {
            if (side == Side.BUY) revert ExceedsDailyCap(used, notional, ctx.dailyCap);
            revert ExceedsDailySellCap(used, notional, ctx.dailyCap);
        }
    }

    /// @dev Reverts if the L2 sequencer is down or restarted within SEQUENCER_GRACE_PERIOD. Skipped when no uptime
    ///      feed is configured. Per Chainlink, the feed answers 0 for up and 1 for down, and `startedAt` is when the
    ///      status last changed. A zero `startedAt` means the feed is not initialised, which is treated as down.
    function _checkSequencer() internal view {
        AggregatorV3Interface feed = sequencerUptimeFeed;
        if (address(feed) == address(0)) return;
        (, int256 answer, uint256 startedAt,,) = feed.latestRoundData();
        if (answer != SEQUENCER_UP || startedAt == 0) revert SequencerDown();
        uint256 trustedFrom = startedAt + SEQUENCER_GRACE_PERIOD;
        if (block.timestamp < trustedFrom) revert SequencerGracePeriod(trustedFrom);
    }

    /// @dev Returns `amount` reduced by `slippageBps`, rounded down.
    function _applySlippage(uint256 amount, uint256 slippageBps) internal pure returns (uint256) {
        return Math.mulDiv(amount, BPS - slippageBps, BPS);
    }
}
