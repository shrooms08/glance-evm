// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {GlanceVault} from "../src/GlanceVault.sol";
import {GlanceVaultFactory} from "../src/GlanceVaultFactory.sol";
import {TestUSDG} from "../src/testnet/TestUSDG.sol";

/// @title VaultSetup
/// @notice Creates (or reuses) the caller's Glance vault and configures it exactly like the demo vaults, so the Glance
///         API's agent can trade for it: the agent with a fresh expiry, the five Stock Tokens approved with their feeds,
///         the matching StockDesk approved as a router, and the demo's price freshness (20h open / 96h closed). Then it
///         deposits. Every step is skipped when already in place, so it is safe to re-run.
/// @dev Shared by the CreateVault script and its fork test, so the test exercises the exact code a judge runs.
abstract contract VaultSetup is CommonBase {
    uint32 internal constant OPEN_MAX_AGE = 72_000;
    uint32 internal constant CLOSED_MAX_AGE = 345_600;
    uint64 internal constant AGENT_TTL = 29 days;
    uint64 internal constant AGENT_MIN_LEFT = 7 days;

    struct Setup {
        GlanceVaultFactory factory;
        address usdg;
        address desk;
        address agent;
        bool testUsdg;
        address[] tokens;
        address[] feeds;
    }

    /// @dev Every external call goes out from this contract (the broadcaster in a script, the pranked judge in a test).
    function _setUpVault(Setup memory s, address owner, uint256 deposit) internal returns (GlanceVault vault) {
        address existing = s.factory.vaultOf(owner);
        vault = GlanceVault(existing != address(0) ? existing : s.factory.createVault(s.usdg));
        require(
            address(vault.usdg()) == s.usdg,
            "CreateVault: you already have a Glance vault on the other USDG; the factory allows one per owner"
        );

        for (uint256 i; i < s.tokens.length; ++i) {
            (bool approved, address feed, uint32 open, uint32 closed) = vault.tokenConfig(s.tokens[i]);
            if (!approved || feed != s.feeds[i]) vault.setTokenApproval(s.tokens[i], s.feeds[i], true);
            if (open != OPEN_MAX_AGE || closed != CLOSED_MAX_AGE) {
                vault.setTokenFreshness(s.tokens[i], OPEN_MAX_AGE, CLOSED_MAX_AGE);
            }
        }
        if (!vault.approvedRouters(s.desk)) vault.setRouterApproval(s.desk, true);
        if (vault.agent() != s.agent || vault.agentExpiry() < block.timestamp + AGENT_MIN_LEFT) {
            vault.setAgent(s.agent, uint64(block.timestamp) + AGENT_TTL);
        }

        if (deposit == 0) return vault;
        uint256 held = IERC20(s.usdg).balanceOf(owner);
        if (held < deposit && s.testUsdg) {
            uint256 room = TestUSDG(s.usdg).faucetRemaining(owner);
            require(room >= deposit - held, "CreateVault: today's TestUSDG faucet allowance is used up; deposit less");
            TestUSDG(s.usdg).faucet(deposit - held);
        }
        require(
            IERC20(s.usdg).balanceOf(owner) >= deposit,
            "CreateVault: not enough Paxos USDG. Claim some at https://faucet.paxos.com/ (Robinhood Chain testnet)"
        );
        IERC20(s.usdg).approve(address(vault), deposit);
        vault.deposit(deposit);
    }

    /// @dev Reads the demo's addresses from deployments/<chain>.json. `testUsdg` picks the TestUSDG fallback.
    function _setupFromDeployment(string memory json, bool testUsdg) internal pure returns (Setup memory s) {
        string memory v = testUsdg ? ".demoVaultTestUSDG" : ".demoVaultPaxosUSDG";
        s.factory = GlanceVaultFactory(vm.parseJsonAddress(json, ".factory.address"));
        s.usdg = vm.parseJsonAddress(json, string.concat(v, ".usdg"));
        s.desk = vm.parseJsonAddress(json, string.concat(v, ".stockDesk"));
        s.agent = vm.parseJsonAddress(json, string.concat(v, ".agent"));
        s.testUsdg = testUsdg;
        string[5] memory symbols = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];
        s.tokens = new address[](symbols.length);
        s.feeds = new address[](symbols.length);
        for (uint256 i; i < symbols.length; ++i) {
            string memory k = string.concat(".stocks.", symbols[i]);
            s.tokens[i] = vm.parseJsonAddress(json, string.concat(k, ".token"));
            s.feeds[i] = vm.parseJsonAddress(json, string.concat(k, ".feed"));
        }
    }
}

/// @title CreateVault
/// @notice `make create-vault`: your own Glance vault on Robinhood Chain testnet, ready for the Glance agent.
/// @dev Environment:
///        VAULT_USDG     "paxos" (default: real Paxos USDG from https://faucet.paxos.com/) or "test" (TestUSDG, which
///                       this script takes from its on-chain faucet for you)
///        DEPOSIT        whole USDG to deposit (default 10)
///        AGENT          the agent to authorise (default: the Glance API's agent from the deployment record; set it
///                       only if you run your own API with your own AGENT_PRIVATE_KEY)
contract CreateVault is Script, VaultSetup {
    function run() external {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        require(vm.exists(path), "CreateVault: no Glance deployment on this chain");
        string memory json = vm.readFile(path);
        bool testUsdg = keccak256(bytes(vm.envOr("VAULT_USDG", string("paxos")))) == keccak256("test");
        uint256 deposit = vm.envOr("DEPOSIT", uint256(10)) * 1e6;
        Setup memory s = _setupFromDeployment(json, testUsdg);
        s.agent = vm.envOr("AGENT", s.agent);

        vm.startBroadcast();
        (, address owner,) = vm.readCallers();
        GlanceVault vault = _setUpVault(s, owner, deposit);
        vm.stopBroadcast();

        console2.log("");
        console2.log("Your Glance vault       ", address(vault));
        console2.log(testUsdg ? "  on TestUSDG (fallback)" : "  on the real Paxos USDG", s.usdg);
        console2.log("  owner (you)           ", owner);
        console2.log("  agent (Glance API)    ", s.agent);
        console2.log("  trades through desk   ", s.desk);
        console2.log("  whole USDG in vault   ", IERC20(s.usdg).balanceOf(address(vault)) / 1e6);
        console2.log("Paste the vault address into Glance's settings (Vault address), then buy from any headline.");
    }
}
