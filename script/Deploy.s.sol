// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {GlanceVault} from "../src/GlanceVault.sol";
import {GlanceVaultFactory} from "../src/GlanceVaultFactory.sol";
import {StockDesk} from "../src/testnet/StockDesk.sol";
import {TestPriceFeed} from "../src/testnet/TestPriceFeed.sol";
import {TestStockToken} from "../src/testnet/TestStockToken.sol";
import {TestUSDG} from "../src/testnet/TestUSDG.sol";

/// @title Deploy
/// @notice Deploys Glance to Robinhood Chain testnet (46630), Arbitrum Sepolia (421614) or a local anvil (31337).
/// @dev Uses real infrastructure where docs/CHAIN_NOTES.md verified it exists, and testnet stand-ins elsewhere.
///      Safe to re-run: anything recorded in deployments/<chainid>.json that still has code on chain is reused, desk
///      inventory is only topped up to its target, and vault settings are only written when they differ.
///      deployments/<chainid>.json is written only on a real broadcast; dry runs write <chainid>.dry-run.json.
///
///      On Robinhood Chain testnet it deploys two demo vaults:
///        demoVaultPaxosUSDG  on the real Paxos USDG (https://faucet.paxos.com/): the primary demo vault. The deploy
///                            configures it; `make fund-paxos` stocks its desk and funds it.
///        demoVaultTestUSDG   on TestUSDG, which anyone can fund from its on-chain faucet: the fallback
///
///      Environment (all optional except the broadcaster key, which is passed on the command line):
///        AGENT_ADDRESS          agent key to authorise on the demo vaults
///        AGENT_TTL_DAYS         agent key lifetime in days (default 29, the vault caps it at 30)
///        USDG_ADDRESS           use this existing USDG for the primary vault instead of deploying TestUSDG
///        SEQUENCER_UPTIME_FEED  Chainlink L2 sequencer uptime feed (none exists on either testnet today)
///        PRICE_<SYMBOL>         8-decimal USD price for a stand-in feed, e.g. PRICE_TSLA=38025740000
///        PRICE_SOURCE_<SYMBOL>  where that price came from; script/fetch-prices.sh sets it for prices it fetched.
///                               A PRICE_<SYMBOL> without a source is recorded as coming from the environment.
///        DESK_USDG_TARGET       desk USDG inventory target, raw units (default 250,000 USDG)
///        DESK_STOCK_TARGET      desk inventory target per stock, raw units (default 1,000 shares)
contract Deploy is Script {
    uint256 internal constant ROBINHOOD_TESTNET = 46_630;
    uint256 internal constant ARBITRUM_SEPOLIA = 421_614;
    uint256 internal constant ANVIL = 31_337;

    /// @dev Real Paxos USDG on Robinhood Chain testnet (verified in docs/CHAIN_NOTES.md). Nothing dispenses it.
    address internal constant PAXOS_USDG_RH_TESTNET = 0x7E955252E15c84f5768B83c41a71F9eba181802F;

    uint8 internal constant FEED_DECIMALS = 8;
    uint8 internal constant STOCK_DECIMALS = 18;
    uint256 internal constant DEFAULT_AGENT_TTL_DAYS = 29;
    uint256 internal constant DEFAULT_DESK_USDG_TARGET = 250_000e6;
    uint256 internal constant DEFAULT_DESK_STOCK_TARGET = 1_000e18;

    string internal constant RH_FAUCET = "https://faucet.testnet.chain.robinhood.com";
    string internal constant SNAPSHOT_SOURCE = "snapshot: Chainlink Robinhood mainnet, 2026-09-23";
    string internal constant PAXOS_FAUCET = "https://faucet.paxos.com/";
    string internal constant PAXOS_NOTE =
        "Primary demo vault, on the real Paxos USDG. Anyone can claim Paxos USDG at https://faucet.paxos.com/. Stocked and funded by make fund-paxos.";
    string internal constant TEST_NOTE =
        "Fallback vault on our TestUSDG stand-in, for anyone without Paxos USDG: fund it from the on-chain faucet.";

    /// @dev One listed stock and where each of its parts came from.
    struct Stock {
        string symbol;
        address token;
        bool tokenReal;
        address feed;
        bool feedReal;
        int256 price;
        string priceSource;
    }

    string internal _existing;
    address internal _deployer;

    Stock[] internal _stocks;
    string[] internal _skipped;

    address internal _usdg;
    bool internal _usdgReal;
    GlanceVaultFactory internal _factory;
    StockDesk internal _desk;
    GlanceVault internal _vault;
    StockDesk internal _paxosDesk;
    GlanceVault internal _paxosVault;

    function run() external {
        uint256 chainId = block.chainid;
        require(
            chainId == ROBINHOOD_TESTNET || chainId == ARBITRUM_SEPOLIA || chainId == ANVIL,
            "Deploy: unsupported chain (expected 46630, 421614 or 31337)"
        );
        _existing = _readExisting(chainId);

        vm.startBroadcast();
        (, _deployer,) = vm.readCallers();
        console2.log("== Glance deploy on chain", chainId);
        console2.log("deployer", _deployer);

        _deployCore();
        _loadStocks(chainId);

        // Primary demo: the vault anyone can fund.
        for (uint256 i; i < _stocks.length; ++i) {
            _listOnDesk(_desk, _stocks[i], true);
        }
        _seedUsdg(_desk, _usdg, _usdgReal);
        _vault = _factoryVault();
        _configureVault(_vault, _desk);

        // Robinhood testnet: a second vault on the real Paxos USDG.
        if (chainId == ROBINHOOD_TESTNET && _usdg != PAXOS_USDG_RH_TESTNET) _deployPaxosDemo();
        vm.stopBroadcast();

        _log();
        _write(chainId);
    }

    // ---------------------------------------------------------------------
    // Deployment steps
    // ---------------------------------------------------------------------

    function _deployCore() internal {
        (_usdg, _usdgReal) = _resolveUsdg();
        _factory = GlanceVaultFactory(_reuse(".factory"));
        if (address(_factory) == address(0)) _factory = new GlanceVaultFactory();
        _desk = _deskFor(".stockDesk", _usdg);
    }

    /// @dev Robinhood Chain testnet has real Stock Tokens (dispensed by the official faucet) but no Chainlink feeds.
    ///      Arbitrum Sepolia and anvil have neither. A stock with no trustworthy price is skipped, not mispriced.
    function _loadStocks(uint256 chainId) internal {
        string[5] memory symbols = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];
        address[5] memory rhTokens = [
            0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E,
            0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02,
            0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0,
            0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93,
            0x71178BAc73cBeb415514eB542a8995b82669778d
        ];
        // Last-resort snapshot of the Chainlink Robinhood mainnet answers on 2026-09-23 (8 dp). NFLX has no Chainlink
        // feed, so it has no snapshot: without a public quote or PRICE_NFLX it is skipped.
        uint256[5] memory snapshot = [uint256(38_025_740_000), 25_559_100_000, 18_467_245_000, 0, 62_110_500_000];

        for (uint256 i; i < symbols.length; ++i) {
            (uint256 price, string memory source) = _price(symbols[i], snapshot[i]);
            if (price == 0) {
                _skipped.push(symbols[i]);
                continue;
            }
            Stock memory s;
            s.symbol = symbols[i];
            s.price = int256(price);
            s.priceSource = source;
            if (chainId == ROBINHOOD_TESTNET) {
                s.token = rhTokens[i];
                s.tokenReal = true;
            } else {
                s.token = _testStock(symbols[i]);
            }
            s.feed = _feed(s);
            _stocks.push(s);
        }
    }

    function _deployPaxosDemo() internal {
        require(PAXOS_USDG_RH_TESTNET.code.length != 0, "Deploy: Paxos USDG has no code on this chain");
        // A StockDesk quotes exactly one USDG, so the Paxos vault needs its own desk over the same feeds and spread.
        _paxosDesk = _deskFor(".stockDeskPaxosUSDG", PAXOS_USDG_RH_TESTNET);
        // Listed but not stocked: the faucet Stock Tokens the deployer holds go to the fundable desk.
        for (uint256 i; i < _stocks.length; ++i) {
            _listOnDesk(_paxosDesk, _stocks[i], false);
        }
        _seedUsdg(_paxosDesk, PAXOS_USDG_RH_TESTNET, true);

        // The factory allows one vault per owner, so this one is deployed directly. It is the same contract.
        _paxosVault = GlanceVault(_reuse(".demoVaultPaxosUSDG"));
        if (
            address(_paxosVault) == address(0) || address(_paxosVault.usdg()) != PAXOS_USDG_RH_TESTNET
                || _paxosVault.owner() != _deployer
        ) {
            _paxosVault = new GlanceVault(_deployer, PAXOS_USDG_RH_TESTNET);
        }
        _configureVault(_paxosVault, _paxosDesk);
        _copyLimits(_vault, _paxosVault);
    }

    // ---------------------------------------------------------------------
    // Prices, tokens, feeds
    // ---------------------------------------------------------------------

    /// @dev Price precedence: a value fetched at deploy time (PRICE_<S> + PRICE_SOURCE_<S>, from script/fetch-prices.sh),
    ///      then a bare PRICE_<S> from the environment, then the dated snapshot. Zero means "no price: skip".
    function _price(string memory symbol, uint256 snapshotPrice)
        internal
        view
        returns (uint256 price, string memory source)
    {
        price = vm.envOr(string.concat("PRICE_", symbol), uint256(0));
        if (price != 0) {
            source = vm.envOr(string.concat("PRICE_SOURCE_", symbol), string.concat("env: PRICE_", symbol));
            return (price, source);
        }
        return (snapshotPrice, snapshotPrice == 0 ? "" : SNAPSHOT_SOURCE);
    }

    function _resolveUsdg() internal returns (address usdg, bool real) {
        address configured = vm.envOr("USDG_ADDRESS", address(0));
        if (configured != address(0)) {
            require(configured.code.length != 0, "Deploy: USDG_ADDRESS has no code on this chain");
            return (configured, true);
        }
        // Reuse a recorded USDG only if it was our own TestUSDG.
        bool recordedReal = bytes(_existing).length != 0 && vm.keyExistsJson(_existing, ".usdg.real")
            && vm.parseJsonBool(_existing, ".usdg.real");
        if (!recordedReal) usdg = _reuse(".usdg.address");
        if (usdg == address(0)) usdg = address(new TestUSDG(_deployer));
    }

    function _testStock(string memory symbol) internal returns (address token) {
        token = _reuse(string.concat(".stocks.", symbol, ".token"));
        if (token == address(0)) {
            token = address(
                new TestStockToken(
                    string.concat(symbol, " Test Stock (Glance testnet stand-in)"), symbol, STOCK_DECIMALS, _deployer
                )
            );
        }
    }

    /// @dev Reuses a recorded TestPriceFeed and refreshes its price, or deploys a new one.
    function _feed(Stock memory stock) internal returns (address feed) {
        feed = _reuse(string.concat(".stocks.", stock.symbol, ".feed"));
        if (feed == address(0)) {
            return
                address(new TestPriceFeed(FEED_DECIMALS, string.concat(stock.symbol, " / USD"), stock.price, _deployer));
        }
        TestPriceFeed(feed).setPrice(stock.price);
    }

    // ---------------------------------------------------------------------
    // Desks and vaults
    // ---------------------------------------------------------------------

    function _deskFor(string memory key, address usdg) internal returns (StockDesk desk) {
        desk = StockDesk(_reuse(key));
        if (address(desk) == address(0) || address(desk.usdg()) != usdg) desk = new StockDesk(usdg, _deployer);
        require(desk.owner() == _deployer, "Deploy: recorded desk is owned by another address");
    }

    function _listOnDesk(StockDesk desk, Stock memory stock, bool stockIt) internal {
        if (address(desk.feedOf(stock.token)) != stock.feed) desk.setFeed(stock.token, stock.feed);
        if (!stockIt) return;
        uint256 target = vm.envOr("DESK_STOCK_TARGET", DEFAULT_DESK_STOCK_TARGET);
        uint256 have = IERC20(stock.token).balanceOf(address(desk));
        if (have >= target) return;
        uint256 add = target - have;
        if (stock.tokenReal) {
            // Real Stock Tokens cannot be minted: seed whatever the deployer claimed from the faucet.
            uint256 balance = IERC20(stock.token).balanceOf(_deployer);
            add = balance < add ? balance : add;
        } else {
            TestStockToken(stock.token).mint(_deployer, add);
        }
        _seed(desk, stock.token, add);
    }

    function _seedUsdg(StockDesk desk, address usdg, bool real) internal {
        uint256 target = vm.envOr("DESK_USDG_TARGET", DEFAULT_DESK_USDG_TARGET);
        uint256 have = IERC20(usdg).balanceOf(address(desk));
        if (have >= target) return;
        uint256 add = target - have;
        if (real) {
            uint256 balance = IERC20(usdg).balanceOf(_deployer);
            add = balance < add ? balance : add;
        } else {
            TestUSDG(usdg).mint(_deployer, add);
        }
        _seed(desk, usdg, add);
    }

    function _seed(StockDesk desk, address token, uint256 amount) internal {
        if (amount == 0) return;
        IERC20(token).approve(address(desk), amount);
        desk.seed(token, amount);
    }

    function _factoryVault() internal returns (GlanceVault vault) {
        vault = GlanceVault(_factory.vaultOf(_deployer));
        if (address(vault) == address(0)) vault = GlanceVault(_factory.createVault(_usdg));
        require(address(vault.usdg()) == _usdg, "Deploy: deployer's vault holds a different USDG (one vault per owner)");
    }

    function _configureVault(GlanceVault vault, StockDesk desk) internal {
        for (uint256 i; i < _stocks.length; ++i) {
            (bool approved, address feed,,) = vault.tokenConfig(_stocks[i].token);
            if (!approved || feed != _stocks[i].feed) vault.setTokenApproval(_stocks[i].token, _stocks[i].feed, true);
        }
        if (!vault.approvedRouters(address(desk))) vault.setRouterApproval(address(desk), true);

        address agent = vm.envOr("AGENT_ADDRESS", address(0));
        // Refresh the key when it changed or has less than a day left.
        if (agent != address(0) && (vault.agent() != agent || vault.agentExpiry() < block.timestamp + 1 days)) {
            uint256 ttl = vm.envOr("AGENT_TTL_DAYS", DEFAULT_AGENT_TTL_DAYS) * 1 days;
            vault.setAgent(agent, uint64(block.timestamp + ttl));
        }

        address sequencer = vm.envOr("SEQUENCER_UPTIME_FEED", _knownSequencerFeed(block.chainid));
        if (address(vault.sequencerUptimeFeed()) != sequencer) vault.setSequencerUptimeFeed(sequencer);
    }

    /// @dev Gives `to` the same limits and per-token freshness thresholds as `from`.
    function _copyLimits(GlanceVault from, GlanceVault to) internal {
        if (
            to.perBuyCap() != from.perBuyCap() || to.dailyCap() != from.dailyCap()
                || to.dailySellCap() != from.dailySellCap() || to.maxSlippageBps() != from.maxSlippageBps()
                || to.weekendCapBps() != from.weekendCapBps()
        ) {
            to.setLimits(
                from.perBuyCap(), from.dailyCap(), from.dailySellCap(), from.maxSlippageBps(), from.weekendCapBps()
            );
        }
        for (uint256 i; i < _stocks.length; ++i) {
            (,, uint32 openA, uint32 closedA) = from.tokenConfig(_stocks[i].token);
            (,, uint32 openB, uint32 closedB) = to.tokenConfig(_stocks[i].token);
            if (openA != openB || closedA != closedB) to.setTokenFreshness(_stocks[i].token, openA, closedA);
        }
    }

    /// @dev Chainlink L2 sequencer uptime feeds verified for each chain. Chainlink publishes none for Robinhood Chain
    ///      (testnet or mainnet) or Arbitrum Sepolia as of 2026-09-23 (docs/CHAIN_NOTES.md), so the check stays off.
    function _knownSequencerFeed(uint256) internal pure returns (address) {
        return address(0);
    }

    // ---------------------------------------------------------------------
    // Output
    // ---------------------------------------------------------------------

    function _log() internal view {
        console2.log("");
        console2.log("== Deployed / reused");
        console2.log("GlanceVaultFactory        [glance]  ", address(_factory));
        console2.log("StockDesk                 [STAND-IN]", address(_desk));
        console2.log("demoVaultTestUSDG         [glance]  ", address(_vault));
        console2.log(_usdgReal ? "USDG                      [REAL]    " : "USDG                      [STAND-IN]", _usdg);
        if (address(_paxosVault) != address(0)) {
            console2.log("demoVaultPaxosUSDG        [glance]  ", address(_paxosVault));
            console2.log("  on Paxos USDG           [REAL]    ", PAXOS_USDG_RH_TESTNET);
            console2.log("  StockDesk (Paxos USDG)  [STAND-IN]", address(_paxosDesk));
            console2.log("  primary demo vault; next: make fund-paxos (Paxos USDG from https://faucet.paxos.com/)");
        }
        for (uint256 i; i < _stocks.length; ++i) {
            Stock memory s = _stocks[i];
            console2.log(string.concat(s.symbol, s.tokenReal ? " token  [REAL]    " : " token  [STAND-IN]"), s.token);
            console2.log(string.concat(s.symbol, s.feedReal ? " feed   [REAL]    " : " feed   [STAND-IN]"), s.feed);
            // forge-lint: disable-next-line(unsafe-typecast)
            console2.log(string.concat(s.symbol, " price (8dp) <- ", s.priceSource), uint256(s.price));
            uint256 inventory = IERC20(s.token).balanceOf(address(_desk));
            console2.log(string.concat(s.symbol, " desk inventory (raw)"), inventory);
            if (s.tokenReal && inventory == 0) {
                console2.log(
                    string.concat(
                        "  WARNING: desk holds no real ", s.symbol, ". Claim from ", RH_FAUCET, " and re-run."
                    )
                );
            }
        }
        for (uint256 i; i < _skipped.length; ++i) {
            console2.log(
                string.concat(_skipped[i], " SKIPPED: no public quote and no PRICE_", _skipped[i], "; not listed")
            );
        }
        console2.log("desk USDG inventory (raw)", IERC20(_usdg).balanceOf(address(_desk)));
        console2.log("agent", _vault.agent());
        console2.log("sequencer uptime feed", address(_vault.sequencerUptimeFeed()));
    }

    function _write(uint256 chainId) internal {
        string memory root = "root";
        vm.serializeUint(root, "chainId", chainId);
        vm.serializeUint(root, "blockNumber", block.number);
        vm.serializeUint(root, "timestamp", block.timestamp);
        vm.serializeAddress(root, "deployer", _deployer);
        vm.serializeString(root, "pricesFetchedAt", vm.envOr("PRICES_FETCHED_AT", string("")));
        vm.serializeAddress(root, "sequencerUptimeFeed", address(_vault.sequencerUptimeFeed()));
        vm.serializeString(root, "usdg", _usdgJson());
        vm.serializeString(root, "factory", _contractJson("factory", address(_factory), "glance"));
        vm.serializeString(
            root,
            "stockDesk",
            _contractJson("desk", address(_desk), "testnet stand-in (oracle-priced desk, not an AMM)")
        );
        bool paxosPrimary = address(_paxosVault) != address(0);
        vm.serializeString(root, "primaryVault", paxosPrimary ? "demoVaultPaxosUSDG" : "demoVaultTestUSDG");
        vm.serializeString(
            root,
            "demoVaultTestUSDG",
            _vaultJson(
                "vaultTest",
                _vault,
                _usdg,
                _desk,
                VaultMeta({
                    fundable: true,
                    primary: !paxosPrimary,
                    faucetUrl: _testFaucet(),
                    note: paxosPrimary ? TEST_NOTE : ""
                })
            )
        );
        if (paxosPrimary) {
            vm.serializeString(
                root,
                "stockDeskPaxosUSDG",
                _contractJson("deskPaxos", address(_paxosDesk), "testnet stand-in quoting the real Paxos USDG")
            );
            vm.serializeString(
                root,
                "demoVaultPaxosUSDG",
                _vaultJson(
                    "vaultPaxos",
                    _paxosVault,
                    PAXOS_USDG_RH_TESTNET,
                    _paxosDesk,
                    VaultMeta({fundable: true, primary: true, faucetUrl: PAXOS_FAUCET, note: PAXOS_NOTE})
                )
            );
        }
        string memory json = vm.serializeString(root, "stocks", _stocksJson());

        // Only the keys this script owns are written. When a record already exists, it goes to a separate file that
        // script/merge-deployment.sh merges into the record (script/deploy.sh does it), so every key this script doesn't
        // own (factoryV2, the ETF stand-ins under stocks.*, anything added later) is kept.
        bool broadcast = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        string memory base = string.concat("deployments/", vm.toString(chainId));
        string memory path = !broadcast
            ? string.concat(base, ".dry-run.json")
            : bytes(_existing).length == 0 ? string.concat(base, ".json") : string.concat(base, ".deploy-output.json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }

    function _usdgJson() internal returns (string memory) {
        vm.serializeAddress("usdg", "address", _usdg);
        vm.serializeBool("usdg", "real", _usdgReal);
        return vm.serializeString("usdg", "source", _usdgReal ? "USDG_ADDRESS (external)" : "TestUSDG (public faucet)");
    }

    function _contractJson(string memory key, address a, string memory kind) internal returns (string memory) {
        vm.serializeAddress(key, "address", a);
        return vm.serializeString(key, "kind", kind);
    }

    /// @dev What the deployment record says about a demo vault beyond its on-chain state.
    struct VaultMeta {
        bool fundable;
        bool primary;
        string faucetUrl;
        string note;
    }

    function _testFaucet() internal view returns (string memory) {
        if (_usdgReal) return "";
        return string.concat("TestUSDG.faucet(amount) on ", vm.toString(_usdg), " (1,000 per address per UTC day)");
    }

    function _vaultJson(string memory key, GlanceVault vault, address usdg, StockDesk desk, VaultMeta memory meta)
        internal
        returns (string memory)
    {
        vm.serializeAddress(key, "address", address(vault));
        vm.serializeAddress(key, "usdg", usdg);
        vm.serializeAddress(key, "stockDesk", address(desk));
        vm.serializeAddress(key, "owner", vault.owner());
        vm.serializeAddress(key, "agent", vault.agent());
        vm.serializeUint(key, "agentExpiry", vault.agentExpiry());
        vm.serializeUint(key, "usdgBalance", IERC20(usdg).balanceOf(address(vault)));
        vm.serializeBool(key, "fundableFromFaucet", meta.fundable);
        vm.serializeBool(key, "primary", meta.primary);
        vm.serializeString(key, "faucetUrl", meta.faucetUrl);
        return vm.serializeString(key, "note", meta.note);
    }

    function _stocksJson() internal returns (string memory out) {
        for (uint256 i; i < _stocks.length; ++i) {
            out = vm.serializeString("stocks", _stocks[i].symbol, _stockJson(_stocks[i]));
        }
        for (uint256 i; i < _skipped.length; ++i) {
            string memory k = string.concat("skipped-", _skipped[i]);
            vm.serializeBool(k, "skipped", true);
            string memory entry = vm.serializeString(
                k, "reason", "no Chainlink feed, public quote fetch failed and no PRICE_ env value; not listed"
            );
            out = vm.serializeString("stocks", _skipped[i], entry);
        }
    }

    function _stockJson(Stock memory s) internal returns (string memory) {
        string memory k = string.concat("stock-", s.symbol);
        vm.serializeBool(k, "skipped", false);
        vm.serializeAddress(k, "token", s.token);
        vm.serializeBool(k, "tokenReal", s.tokenReal);
        vm.serializeString(k, "tokenSource", s.tokenReal ? "Robinhood testnet faucet token" : "TestStockToken");
        vm.serializeUint(k, "tokenDecimals", IERC20Metadata(s.token).decimals());
        vm.serializeAddress(k, "feed", s.feed);
        vm.serializeBool(k, "feedReal", s.feedReal);
        vm.serializeString(k, "feedSource", s.feedReal ? "Chainlink" : "TestPriceFeed");
        vm.serializeString(k, "priceSource", s.priceSource);
        vm.serializeString(k, "priceSourceKind", _sourceKind(s.priceSource));
        vm.serializeUint(k, "priceDecimals", FEED_DECIMALS);
        return vm.serializeInt(k, "price", s.price);
    }

    /// @dev Machine-readable provenance for the console: chainlink-live, public-quote, env or snapshot.
    function _sourceKind(string memory source) internal pure returns (string memory) {
        if (_startsWith(source, "chainlink-live")) return "chainlink-live";
        if (_startsWith(source, "public-quote")) return "public-quote";
        if (_startsWith(source, "env")) return "env";
        return "snapshot";
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _readExisting(uint256 chainId) internal view returns (string memory) {
        string memory path = string.concat("deployments/", vm.toString(chainId), ".json");
        return vm.exists(path) ? vm.readFile(path) : "";
    }

    /// @dev Address recorded under `key` in the existing deployment file, if it still has code on this chain.
    function _reuse(string memory key) internal view returns (address a) {
        if (bytes(_existing).length == 0 || !vm.keyExistsJson(_existing, key)) return address(0);
        // Top-level entries are objects with an "address" field.
        string memory full =
            vm.keyExistsJson(_existing, string.concat(key, ".address")) ? string.concat(key, ".address") : key;
        a = vm.parseJsonAddress(_existing, full);
        if (a.code.length == 0) return address(0);
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(prefix);
        if (a.length < b.length) return false;
        for (uint256 i; i < b.length; ++i) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }
}
