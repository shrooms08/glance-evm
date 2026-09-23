// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TokenInit, VaultConfig} from "../../src/ConfiguredGlanceVault.sol";
import {GlanceVault} from "../../src/GlanceVault.sol";
import {GlanceVaultFactoryV2} from "../../src/GlanceVaultFactoryV2.sol";
import {StockDesk} from "../../src/testnet/StockDesk.sol";
import {VaultSetup} from "../../script/CreateVault.s.sol";

/// @notice The console's new Get started, on a fork of Robinhood Chain testnet with the real deployment and the real
///         Paxos USDG: approve, then ONE transaction creates a vault configured exactly like `make create-vault`
///         leaves one, and funded. The Glance agent can then buy $10 of TSLA through the real desk.
contract FactoryV2ForkTest is Test, VaultSetup {
    address internal constant PAXOS_USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;
    string internal json;
    address internal judge = makeAddr("judge");

    function setUp() public {
        try vm.createSelectFork("robinhood_testnet") {}
        catch {
            vm.skip(true);
            return;
        }
        json = vm.readFile("deployments/46630.json");
    }

    /// @dev The console's defaults: the deployment's agent (30 days), the five stocks with 20h/96h freshness, the
    ///      Paxos desk, and $100 / $500 / $500, 1% slippage, 25% while closed.
    function _consoleConfig(Setup memory s) internal view returns (VaultConfig memory c) {
        c.usdg = s.usdg;
        c.agent = s.agent;
        c.agentExpiry = uint64(block.timestamp + 30 days);
        c.tokens = new TokenInit[](s.tokens.length);
        for (uint256 i; i < s.tokens.length; ++i) {
            c.tokens[i] = TokenInit(s.tokens[i], s.feeds[i], OPEN_MAX_AGE, CLOSED_MAX_AGE);
        }
        c.routers = new address[](1);
        c.routers[0] = s.desk;
        c.perBuyCap = 100e6;
        c.dailyCap = 500e6;
        c.dailySellCap = 500e6;
        c.maxSlippageBps = 100;
        c.weekendCapBps = 2_500;
    }

    function test_fork_oneTransactionVaultOnRealPaxosUsdg() public {
        Setup memory s = _setupFromDeployment(json, false);
        assertEq(s.usdg, PAXOS_USDG);
        GlanceVaultFactoryV2 factory = new GlanceVaultFactoryV2();
        deal(PAXOS_USDG, judge, 25e6); // stands in for the https://faucet.paxos.com/ claim

        VaultConfig memory c = _consoleConfig(s);
        vm.startPrank(judge);
        IERC20(PAXOS_USDG).approve(address(factory), 10e6);
        GlanceVault vault = GlanceVault(factory.createVaultWithConfig(c, 10e6));
        vm.stopPrank();

        assertEq(vault.owner(), judge);
        assertEq(factory.vaultOf(judge), address(vault));
        assertEq(IERC20(PAXOS_USDG).balanceOf(address(vault)), 10e6);
        assertEq(IERC20(PAXOS_USDG).balanceOf(judge), 15e6);
        assertEq(IERC20(PAXOS_USDG).balanceOf(address(factory)), 0);
        assertEq(IERC20(PAXOS_USDG).allowance(judge, address(factory)), 0);
        assertEq(vault.usdgDecimals(), 6);
        assertTrue(vault.isActiveAgent(s.agent));
        assertTrue(vault.approvedRouters(s.desk));
        assertEq(vault.perBuyCap(), 100e6);
        for (uint256 i; i < s.tokens.length; ++i) {
            (bool approved, address feed, uint32 open, uint32 closed) = vault.tokenConfig(s.tokens[i]);
            assertTrue(approved);
            assertEq(feed, s.feeds[i]);
            assertEq(open, OPEN_MAX_AGE);
            assertEq(closed, CLOSED_MAX_AGE);
        }

        // One vault per owner in this factory too.
        vm.prank(judge);
        vm.expectRevert(abi.encodeWithSelector(GlanceVaultFactoryV2.VaultAlreadyExists.selector, address(vault)));
        factory.createVaultWithConfig(c, 0);

        // The Glance agent buys $10 of TSLA for the judge through the real Paxos desk.
        StockDesk desk = StockDesk(s.desk);
        if (desk.inventory(s.tokens[0]) < 1e18) deal(s.tokens[0], s.desk, 1e18);
        uint256 quote = desk.quoteBuy(s.tokens[0], 10e6);
        vm.prank(s.agent);
        uint256 got = vault.buy(s.tokens[0], s.desk, 10e6, quote);
        assertEq(got, quote);
        assertEq(IERC20(PAXOS_USDG).balanceOf(address(vault)), 0);
    }

    function test_fork_zeroDepositOnRealPaxosUsdg() public {
        Setup memory s = _setupFromDeployment(json, false);
        GlanceVaultFactoryV2 factory = new GlanceVaultFactoryV2();
        vm.prank(judge);
        GlanceVault vault = GlanceVault(factory.createVaultWithConfig(_consoleConfig(s), 0));
        assertEq(vault.owner(), judge);
        assertEq(IERC20(PAXOS_USDG).balanceOf(address(vault)), 0);
        assertTrue(vault.isActiveAgent(s.agent));
    }
}
