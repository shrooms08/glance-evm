// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

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
///      Environment (all optional except the broadcaster key, which is passed on the command line):
///        AGENT_ADDRESS          agent key to authorise on the demo vault
///        AGENT_TTL_DAYS         agent key lifetime in days (default 29, the vault caps it at 30)
///        USDG_ADDRESS           use this existing USDG instead of deploying TestUSDG
///        SEQUENCER_UPTIME_FEED  Chainlink L2 sequencer uptime feed (none exists on either testnet today)
///        PRICE_<SYMBOL>         8-decimal USD price for a stand-in feed, e.g. PRICE_TSLA=38025740000
///        PRICE_SOURCE           where those prices came from (make sets this when it reads mainnet Chainlink)
///        DESK_USDG_TARGET       desk USDG inventory target, raw units (default 250,000 USDG)
///        DESK_STOCK_TARGET      desk inventory target per stock, raw units (default 1,000 shares)
contract Deploy is Script {
    uint256 internal constant ROBINHOOD_TESTNET = 46_630;
    uint256 internal constant ARBITRUM_SEPOLIA = 421_614;
    uint256 internal constant ANVIL = 31_337;

    uint8 internal constant FEED_DECIMALS = 8;
    uint256 internal constant DEFAULT_AGENT_TTL_DAYS = 29;
    uint256 internal constant DEFAULT_DESK_USDG_TARGET = 250_000e6;
    uint256 internal constant DEFAULT_DESK_STOCK_TARGET = 1_000e18;
    uint8 internal constant STOCK_DECIMALS = 18;

    string internal constant RH_FAUCET = "https://faucet.testnet.chain.robinhood.com";
    string internal constant DEFAULT_PRICE_SOURCE =
        "snapshot of Chainlink Robinhood mainnet feeds, 2026-09-23 (NFLX: manual, no Chainlink feed)";

    /// @dev One listed stock and where each of its parts came from.
    struct Stock {
        string symbol;
        address token;
        bool tokenReal;
        address feed;
        bool feedReal;
        int256 price;
    }

    string internal _existing;
    address internal _deployer;

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

        (address usdg, bool usdgReal) = _usdg();
        GlanceVaultFactory factory = GlanceVaultFactory(_reuse(".factory"));
        if (address(factory) == address(0)) factory = new GlanceVaultFactory();

        StockDesk desk = StockDesk(_reuse(".stockDesk"));
        if (address(desk) == address(0)) desk = new StockDesk(usdg, _deployer);
        require(address(desk.usdg()) == usdg, "Deploy: recorded desk quotes a different USDG");
        require(desk.owner() == _deployer, "Deploy: recorded desk is owned by another address");

        Stock[] memory stocks = _stocks(chainId);
        for (uint256 i; i < stocks.length; ++i) {
            _listOnDesk(desk, stocks[i]);
        }
        _seedDesk(desk, usdg, usdgReal, _envOr("DESK_USDG_TARGET", DEFAULT_DESK_USDG_TARGET));

        GlanceVault vault = _vault(factory, usdg);
        _configureVault(vault, desk, stocks);
        vm.stopBroadcast();

        _log(usdg, usdgReal, factory, desk, vault, stocks);
        _write(chainId, usdg, usdgReal, factory, desk, vault, stocks);
    }

    // ---------------------------------------------------------------------
    // Chain configuration
    // ---------------------------------------------------------------------

    /// @dev Robinhood Chain testnet has real Stock Tokens (dispensed by the official faucet) but no Chainlink feeds.
    ///      Arbitrum Sepolia and anvil have neither. Addresses and evidence: docs/CHAIN_NOTES.md.
    function _stocks(uint256 chainId) internal returns (Stock[] memory s) {
        string[5] memory symbols = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];
        address[5] memory rhTokens = [
            0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E,
            0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02,
            0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0,
            0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93,
            0x71178BAc73cBeb415514eB542a8995b82669778d
        ];
        // Chainlink Robinhood mainnet answers on 2026-09-23 (8 dp). NFLX has no Chainlink feed: manual placeholder.
        int256[5] memory defaults =
            [int256(38_025_740_000), 25_559_100_000, 18_467_245_000, 10_000_000_000, 62_110_500_000];

        s = new Stock[](symbols.length);
        for (uint256 i; i < symbols.length; ++i) {
            s[i].symbol = symbols[i];
            s[i].price = int256(_envOr(string.concat("PRICE_", symbols[i]), uint256(defaults[i])));
            if (chainId == ROBINHOOD_TESTNET) {
                s[i].token = rhTokens[i];
                s[i].tokenReal = true;
            } else {
                s[i].token = _testStock(symbols[i]);
            }
            s[i].feed = _feed(s[i]);
        }
    }

    function _usdg() internal returns (address usdg, bool real) {
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
    // Desk and vault
    // ---------------------------------------------------------------------

    function _listOnDesk(StockDesk desk, Stock memory stock) internal {
        if (address(desk.feedOf(stock.token)) != stock.feed) desk.setFeed(stock.token, stock.feed);
        uint256 target = _envOr("DESK_STOCK_TARGET", DEFAULT_DESK_STOCK_TARGET);
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

    function _seedDesk(StockDesk desk, address usdg, bool usdgReal, uint256 target) internal {
        uint256 have = IERC20(usdg).balanceOf(address(desk));
        if (have >= target) return;
        uint256 add = target - have;
        if (usdgReal) {
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

    function _vault(GlanceVaultFactory factory, address usdg) internal returns (GlanceVault vault) {
        vault = GlanceVault(factory.vaultOf(_deployer));
        if (address(vault) == address(0)) vault = GlanceVault(factory.createVault(usdg));
        require(address(vault.usdg()) == usdg, "Deploy: deployer's vault holds a different USDG (one vault per owner)");
    }

    function _configureVault(GlanceVault vault, StockDesk desk, Stock[] memory stocks) internal {
        for (uint256 i; i < stocks.length; ++i) {
            (bool approved, address feed) = vault.tokenConfig(stocks[i].token);
            if (!approved || feed != stocks[i].feed) vault.setTokenApproval(stocks[i].token, stocks[i].feed, true);
        }
        if (!vault.approvedRouters(address(desk))) vault.setRouterApproval(address(desk), true);

        address agent = vm.envOr("AGENT_ADDRESS", address(0));
        uint64 expiry = uint64(block.timestamp + _envOr("AGENT_TTL_DAYS", DEFAULT_AGENT_TTL_DAYS) * 1 days);
        // Refresh the key when it changed or has less than a day left.
        if (agent != address(0) && (vault.agent() != agent || vault.agentExpiry() < block.timestamp + 1 days)) {
            vault.setAgent(agent, expiry);
        }

        address sequencer = vm.envOr("SEQUENCER_UPTIME_FEED", _knownSequencerFeed(block.chainid));
        if (address(vault.sequencerUptimeFeed()) != sequencer) vault.setSequencerUptimeFeed(sequencer);
    }

    /// @dev Chainlink L2 sequencer uptime feeds verified for each chain. Chainlink publishes none for Robinhood Chain
    ///      (testnet or mainnet) or Arbitrum Sepolia as of 2026-09-23 (docs/CHAIN_NOTES.md), so the check stays off.
    function _knownSequencerFeed(uint256) internal pure returns (address) {
        return address(0);
    }

    // ---------------------------------------------------------------------
    // Output
    // ---------------------------------------------------------------------

    function _log(
        address usdg,
        bool usdgReal,
        GlanceVaultFactory factory,
        StockDesk desk,
        GlanceVault vault,
        Stock[] memory stocks
    ) internal view {
        console2.log("");
        console2.log("== Deployed / reused");
        console2.log("GlanceVaultFactory  [glance]  ", address(factory));
        console2.log("StockDesk           [STAND-IN]", address(desk));
        console2.log("Demo vault          [glance]  ", address(vault));
        console2.log(usdgReal ? "USDG                [REAL]    " : "USDG                [STAND-IN]", usdg);
        for (uint256 i; i < stocks.length; ++i) {
            Stock memory s = stocks[i];
            console2.log(string.concat(s.symbol, s.tokenReal ? " token  [REAL]    " : " token  [STAND-IN]"), s.token);
            console2.log(string.concat(s.symbol, s.feedReal ? " feed   [REAL]    " : " feed   [STAND-IN]"), s.feed);
            uint256 inventory = IERC20(s.token).balanceOf(address(desk));
            console2.log(string.concat(s.symbol, " desk inventory (raw)"), inventory);
            if (s.tokenReal && inventory == 0) {
                console2.log(
                    string.concat(
                        "  WARNING: desk holds no real ",
                        s.symbol,
                        ". Claim from ",
                        RH_FAUCET,
                        " with the deployer and re-run to seed it."
                    )
                );
            }
        }
        console2.log("desk USDG inventory (raw)", IERC20(usdg).balanceOf(address(desk)));
        console2.log("agent", vault.agent());
        console2.log("agent expiry", vault.agentExpiry());
        console2.log("sequencer uptime feed", address(vault.sequencerUptimeFeed()));
    }

    function _write(
        uint256 chainId,
        address usdg,
        bool usdgReal,
        GlanceVaultFactory factory,
        StockDesk desk,
        GlanceVault vault,
        Stock[] memory stocks
    ) internal {
        string memory root = "root";
        vm.serializeUint(root, "chainId", chainId);
        vm.serializeUint(root, "blockNumber", block.number);
        vm.serializeUint(root, "timestamp", block.timestamp);
        vm.serializeAddress(root, "deployer", _deployer);
        vm.serializeString(root, "priceSource", vm.envOr("PRICE_SOURCE", DEFAULT_PRICE_SOURCE));
        vm.serializeAddress(root, "sequencerUptimeFeed", address(vault.sequencerUptimeFeed()));
        vm.serializeString(root, "usdg", _usdgJson(usdg, usdgReal));
        vm.serializeString(root, "factory", _contractJson("factory", address(factory), "glance"));
        vm.serializeString(
            root, "stockDesk", _contractJson("desk", address(desk), "testnet stand-in (oracle-priced desk, not an AMM)")
        );
        vm.serializeString(root, "demoVault", _vaultJson(vault));
        string memory json = vm.serializeString(root, "stocks", _stocksJson(stocks));

        bool broadcast = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        string memory path = string.concat("deployments/", vm.toString(chainId), broadcast ? ".json" : ".dry-run.json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }

    function _usdgJson(address usdg, bool real) internal returns (string memory) {
        vm.serializeAddress("usdg", "address", usdg);
        vm.serializeBool("usdg", "real", real);
        return vm.serializeString("usdg", "source", real ? "USDG_ADDRESS (external)" : "TestUSDG (public faucet)");
    }

    function _contractJson(string memory key, address a, string memory kind) internal returns (string memory) {
        vm.serializeAddress(key, "address", a);
        return vm.serializeString(key, "kind", kind);
    }

    function _vaultJson(GlanceVault vault) internal returns (string memory) {
        vm.serializeAddress("vault", "address", address(vault));
        vm.serializeAddress("vault", "owner", vault.owner());
        vm.serializeAddress("vault", "agent", vault.agent());
        return vm.serializeUint("vault", "agentExpiry", vault.agentExpiry());
    }

    function _stocksJson(Stock[] memory stocks) internal returns (string memory out) {
        for (uint256 i; i < stocks.length; ++i) {
            out = vm.serializeString("stocks", stocks[i].symbol, _stockJson(stocks[i]));
        }
    }

    function _stockJson(Stock memory s) internal returns (string memory) {
        string memory k = string.concat("stock-", s.symbol);
        vm.serializeAddress(k, "token", s.token);
        vm.serializeBool(k, "tokenReal", s.tokenReal);
        vm.serializeString(k, "tokenSource", s.tokenReal ? "Robinhood testnet faucet token" : "TestStockToken");
        vm.serializeUint(k, "tokenDecimals", IERC20Metadata(s.token).decimals());
        vm.serializeAddress(k, "feed", s.feed);
        vm.serializeBool(k, "feedReal", s.feedReal);
        vm.serializeString(k, "feedSource", s.feedReal ? "Chainlink" : "TestPriceFeed");
        vm.serializeUint(k, "priceDecimals", FEED_DECIMALS);
        return vm.serializeInt(k, "price", s.price);
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

    function _envOr(string memory name, uint256 defaultValue) internal view returns (uint256) {
        return vm.envOr(name, defaultValue);
    }
}
