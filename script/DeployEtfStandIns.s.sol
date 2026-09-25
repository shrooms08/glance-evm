// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {StockDesk} from "../src/testnet/StockDesk.sol";
import {TestPriceFeed} from "../src/testnet/TestPriceFeed.sol";
import {TestStockToken} from "../src/testnet/TestStockToken.sol";

/// @title DeployEtfStandIns
/// @notice `make deploy-etf-standins`: testnet stand-ins for two ETF Stock Tokens that exist only on Robinhood Chain
///         MAINNET (SPY, QQQ; docs/CHAIN_NOTES.md). Per ETF: a TestStockToken (18 decimals, its name says it is a
///         testnet stand-in), a TestPriceFeed seeded with the live mainnet Chainlink price AND its updatedAt (the
///         keeper then mirrors that feed), and inventory on both StockDesks (listed with its feed, then stocked).
///         Touches no vault and no factory: vaults opt in (the console's Limits page, or a new vault's default config).
/// @dev Inputs (script/deploy-etf-standins.sh reads them from the mainnet feeds): PRICE_<S>, PRICE_UPDATED_<S>,
///      PRICE_SOURCE_<S>. Idempotent: a token or feed already recorded in deployments/<chain>.json (with code) is reused,
///      and a desk is only topped up to DESK_ETF_TARGET. On a real broadcast it writes deployments/<chain>.etf-standins.json,
///      which the shell script merges into the record under .stocks.SPY and .stocks.QQQ.
contract DeployEtfStandIns is Script {
    uint8 internal constant FEED_DECIMALS = 8;
    uint8 internal constant TOKEN_DECIMALS = 18;
    /// @dev 2 of each ETF per desk (about $1,500 of SPY): plenty for demo-sized buys, and topped up on a re-run.
    uint256 internal constant DEFAULT_DESK_ETF_TARGET = 2e18;

    struct Etf {
        string symbol;
        string name;
        address mainnetToken;
        address mainnetFeed;
        address token;
        address feed;
        int256 price;
        uint256 updatedAt;
        string source;
        bool newToken;
        bool newFeed;
    }

    string internal _record;
    address internal _deployer;
    Etf[] internal _etfs;

    function run() external {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        _record = vm.readFile(path);
        _deployer = vm.parseJsonAddress(_record, ".deployer");
        StockDesk[2] memory desks = [
            StockDesk(vm.parseJsonAddress(_record, ".stockDeskPaxosUSDG.address")),
            StockDesk(vm.parseJsonAddress(_record, ".stockDesk.address"))
        ];
        for (uint256 i; i < desks.length; ++i) {
            require(desks[i].owner() == _deployer, "DeployEtfStandIns: a desk is owned by another address");
        }

        // Robinhood Chain mainnet addresses (https://api.robinhood.com/rhj/assets and Chainlink's Robinhood directory).
        _etfs.push(
            _etf(
                "SPY",
                "SPDR S&P 500 ETF",
                0x117cc2133c37B721F49dE2A7a74833232B3B4C0C,
                0x319724394D3A0e3669269846abE664Cd621f9f6A
            )
        );
        _etfs.push(
            _etf(
                "QQQ",
                "Invesco QQQ",
                0xD5f3879160bc7c32ebb4dC785F8a4F505888de68,
                0x80901d846d5D7B030F26B480776EE3b29374C2ae
            )
        );

        uint256 target = vm.envOr("DESK_ETF_TARGET", DEFAULT_DESK_ETF_TARGET);
        vm.startBroadcast(_deployer);
        for (uint256 i; i < _etfs.length; ++i) {
            Etf storage e = _etfs[i];
            if (e.token == address(0)) {
                e.token = address(
                    new TestStockToken(
                        string.concat(e.name, " (Glance TESTNET STAND-IN, not a Robinhood Stock Token)"),
                        e.symbol,
                        TOKEN_DECIMALS,
                        _deployer
                    )
                );
                e.newToken = true;
            }
            if (e.feed == address(0)) {
                e.feed =
                    address(new TestPriceFeed(FEED_DECIMALS, string.concat(e.symbol, " / USD"), e.price, _deployer));
                e.newFeed = true;
            }
            // A mirror copies the mainnet round's own time, never "now" (a closed market must look closed).
            TestPriceFeed(e.feed).setRoundData(e.price, e.updatedAt > block.timestamp ? block.timestamp : e.updatedAt);
            for (uint256 d; d < desks.length; ++d) {
                _stock(desks[d], e, target);
            }
        }
        vm.stopBroadcast();

        _log(desks, target);
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory out = string.concat("deployments/", vm.toString(block.chainid), ".etf-standins.json");
            vm.writeJson(_json(), out);
            console2.log("wrote", out);
        } else {
            console2.log("dry run: nothing sent, nothing written");
        }
    }

    function _etf(string memory symbol, string memory name, address mainnetToken, address mainnetFeed)
        internal
        view
        returns (Etf memory e)
    {
        e.symbol = symbol;
        e.name = name;
        e.mainnetToken = mainnetToken;
        e.mainnetFeed = mainnetFeed;
        e.price = int256(vm.envUint(string.concat("PRICE_", symbol)));
        require(e.price > 0, "DeployEtfStandIns: no price");
        e.updatedAt = vm.envUint(string.concat("PRICE_UPDATED_", symbol));
        e.source = vm.envString(string.concat("PRICE_SOURCE_", symbol));
        e.token = _reuse(string.concat(".stocks.", symbol, ".token"));
        e.feed = _reuse(string.concat(".stocks.", symbol, ".feed"));
        if (e.token != address(0)) {
            require(TestStockToken(e.token).owner() == _deployer, "DeployEtfStandIns: token owner");
        }
        if (e.feed != address(0)) require(TestPriceFeed(e.feed).owner() == _deployer, "DeployEtfStandIns: feed owner");
    }

    /// @dev Lists the ETF on the desk with its feed, and tops its inventory up to `target` (minted: it's a stand-in).
    function _stock(StockDesk desk, Etf storage e, uint256 target) internal {
        if (address(desk.feedOf(e.token)) != e.feed) desk.setFeed(e.token, e.feed);
        uint256 have = IERC20(e.token).balanceOf(address(desk));
        if (have >= target) return;
        uint256 add = target - have;
        TestStockToken(e.token).mint(_deployer, add);
        IERC20(e.token).approve(address(desk), add);
        desk.seed(e.token, add);
    }

    function _reuse(string memory key) internal view returns (address a) {
        if (!vm.keyExistsJson(_record, key)) return address(0);
        a = vm.parseJsonAddress(_record, key);
        if (a.code.length == 0) return address(0);
    }

    function _log(StockDesk[2] memory desks, uint256 target) internal view {
        console2.log("== ETF stand-ins on chain", block.chainid);
        console2.log("deployer", _deployer);
        for (uint256 i; i < _etfs.length; ++i) {
            Etf storage e = _etfs[i];
            console2.log(e.symbol);
            console2.log("  token (TestStockToken)", e.token, e.newToken ? "new" : "reused");
            console2.log("  feed  (TestPriceFeed) ", e.feed, e.newFeed ? "new" : "reused");
            console2.log("  price (8 decimals)    ", uint256(e.price));
            console2.log("  updatedAt (mainnet)   ", e.updatedAt);
            console2.log("  source                ", e.source);
            console2.log("  mirrors mainnet feed  ", e.mainnetFeed);
            for (uint256 d; d < desks.length; ++d) {
                console2.log("  desk", address(desks[d]), "inventory", IERC20(e.token).balanceOf(address(desks[d])));
            }
        }
        console2.log("desk target per ETF (18 decimals)", target);
    }

    function _json() internal returns (string memory out) {
        for (uint256 i; i < _etfs.length; ++i) {
            Etf storage e = _etfs[i];
            string memory k = string.concat("etf-", e.symbol);
            vm.serializeBool(k, "skipped", false);
            vm.serializeBool(k, "etfStandIn", true);
            vm.serializeAddress(k, "token", e.token);
            vm.serializeBool(k, "tokenReal", false);
            vm.serializeString(
                k,
                "tokenSource",
                string.concat(
                    "TestStockToken: testnet stand-in (the ", e.symbol, " Stock Token exists only on mainnet)"
                )
            );
            vm.serializeUint(k, "tokenDecimals", TOKEN_DECIMALS);
            vm.serializeAddress(k, "mainnetToken", e.mainnetToken);
            vm.serializeAddress(k, "feed", e.feed);
            vm.serializeBool(k, "feedReal", false);
            vm.serializeString(k, "feedSource", "TestPriceFeed");
            vm.serializeAddress(k, "mainnetFeed", e.mainnetFeed);
            vm.serializeString(k, "priceSource", e.source);
            vm.serializeString(k, "priceSourceKind", "chainlink-live");
            vm.serializeUint(k, "priceDecimals", FEED_DECIMALS);
            out = vm.serializeString("etfs", e.symbol, vm.serializeInt(k, "price", e.price));
        }
    }
}
