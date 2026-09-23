// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {GlanceVault} from "../src/GlanceVault.sol";
import {MarketStatusLib} from "../src/MarketStatusLib.sol";
import {StockDesk} from "../src/testnet/StockDesk.sol";
import {TestUSDG} from "../src/testnet/TestUSDG.sol";

/// @title SeedDemo
/// @notice Funds a deployed Glance demo: mints TestUSDG to a named address, deposits USDG into the demo vault, and
///         prints a ready-to-use summary. Run by the vault owner (the deployer) after script/Deploy.s.sol.
/// @dev Environment:
///        DEMO_RECIPIENT       address to receive demo USDG (optional; skipped when unset)
///        DEMO_USDG_AMOUNT     raw USDG minted to DEMO_RECIPIENT (default 1,000 USDG)
///        VAULT_DEPOSIT        raw USDG deposited into the demo vault (default 1,000 USDG)
///      Minting only works when USDG is our TestUSDG. With a real USDG the deployer must already hold the deposit.
contract SeedDemo is Script {
    uint256 internal constant DEFAULT_DEMO_USDG = 1_000e6;
    uint256 internal constant DEFAULT_VAULT_DEPOSIT = 1_000e6;
    string[5] internal SYMBOLS = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];

    function run() external {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        require(vm.exists(path), "SeedDemo: no deployment for this chain, run Deploy first");
        string memory json = vm.readFile(path);

        address usdg = vm.parseJsonAddress(json, ".usdg.address");
        bool usdgReal = vm.parseJsonBool(json, ".usdg.real");
        GlanceVault vault = GlanceVault(vm.parseJsonAddress(json, ".demoVault.address"));
        StockDesk desk = StockDesk(vm.parseJsonAddress(json, ".stockDesk.address"));

        address recipient = vm.envOr("DEMO_RECIPIENT", address(0));
        uint256 demoAmount = vm.envOr("DEMO_USDG_AMOUNT", DEFAULT_DEMO_USDG);
        uint256 deposit = vm.envOr("VAULT_DEPOSIT", DEFAULT_VAULT_DEPOSIT);

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(sender == vault.owner(), "SeedDemo: broadcaster must be the demo vault owner");

        if (recipient != address(0) && demoAmount != 0) {
            require(!usdgReal, "SeedDemo: cannot mint a real USDG; unset DEMO_RECIPIENT");
            TestUSDG(usdg).mint(recipient, demoAmount);
        }
        if (deposit != 0) {
            if (!usdgReal) TestUSDG(usdg).mint(sender, deposit);
            IERC20(usdg).approve(address(vault), deposit);
            vault.deposit(deposit);
        }
        vm.stopBroadcast();

        _summary(json, usdg, usdgReal, vault, desk, recipient, demoAmount);
    }

    function _summary(
        string memory json,
        address usdg,
        bool usdgReal,
        GlanceVault vault,
        StockDesk desk,
        address recipient,
        uint256 demoAmount
    ) internal view {
        console2.log("");
        console2.log("================ Glance demo ready ================");
        console2.log("chain id              ", block.chainid);
        console2.log(usdgReal ? "USDG [REAL]           " : "USDG [STAND-IN]       ", usdg);
        if (!usdgReal) console2.log("  anyone can call faucet(amount) on it, up to 1,000 USDG per address per day");
        if (recipient != address(0)) console2.log("minted demo USDG to   ", recipient, demoAmount);
        console2.log("demo vault            ", address(vault));
        console2.log("  owner               ", vault.owner());
        console2.log("  agent               ", vault.agent());
        console2.log("  agent expiry (unix) ", vault.agentExpiry());
        console2.log("  USDG balance (raw)  ", IERC20(usdg).balanceOf(address(vault)));
        (uint256 perTrade, uint256 dailyBuy, uint256 dailySell) = vault.effectiveCaps(MarketStatusLib.MarketState.OPEN);
        console2.log("  per-trade cap (raw) ", perTrade);
        console2.log("  daily buy cap (raw) ", dailyBuy);
        console2.log("  daily sell cap (raw)", dailySell);
        console2.log("router: StockDesk     ", address(desk));
        console2.log("  spread (bps)        ", desk.spreadBps());

        for (uint256 i; i < SYMBOLS.length; ++i) {
            _logStock(json, SYMBOLS[i], desk);
        }
        console2.log("");
        console2.log("Agent buy example (from the agent key), minOut from the desk's own quote:");
        console2.log("  cast call  <desk>  'quoteBuy(address,uint256)(uint256)' <token> 25000000");
        console2.log("  cast send  <vault> 'buy(address,address,uint256,uint256)' <token> <desk> 25000000 <quote>");
        console2.log("====================================================");
    }

    function _logStock(string memory json, string memory symbol, StockDesk desk) internal view {
        string memory base = string.concat(".stocks.", symbol);
        address token = vm.parseJsonAddress(json, string.concat(base, ".token"));
        bool tokenReal = vm.parseJsonBool(json, string.concat(base, ".tokenReal"));
        bool feedReal = vm.parseJsonBool(json, string.concat(base, ".feedReal"));
        console2.log(string.concat(symbol, tokenReal ? " token [REAL]     " : " token [STAND-IN] "), token);
        console2.log(
            string.concat(symbol, feedReal ? " feed  [REAL]     " : " feed  [STAND-IN] "),
            vm.parseJsonAddress(json, string.concat(base, ".feed"))
        );
        console2.log(string.concat(symbol, " desk inventory    "), desk.inventory(token));
        (, int256 answer,, uint256 updatedAt,) = desk.feedOf(token).latestRoundData();
        // forge-lint: disable-next-line(unsafe-typecast)
        console2.log(string.concat(symbol, " price (8dp)       "), uint256(answer));
        console2.log(string.concat(symbol, " price age (s)     "), block.timestamp - updatedAt);
    }
}
