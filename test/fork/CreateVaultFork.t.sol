// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {GlanceVault} from "../../src/GlanceVault.sol";
import {StockDesk} from "../../src/testnet/StockDesk.sol";
import {VaultSetup} from "../../script/CreateVault.s.sol";

/// @notice The README's "Try it yourself" path, on a fork of Robinhood Chain testnet with the real deployment: a judge
///         with nothing but testnet USDG runs `make create-vault`, and the Glance agent can then buy $10 of TSLA for
///         them through the real desk, with every vault guard applied. Runs the exact code the script runs.
contract CreateVaultForkTest is Test, VaultSetup {
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

    function _judgeFlow(bool testUsdg) internal {
        Setup memory s = _setupFromDeployment(json, testUsdg);
        // Paxos USDG comes from https://faucet.paxos.com/; here deal() stands in for that claim. TestUSDG comes from
        // its own on-chain faucet inside the script.
        if (!testUsdg) deal(s.usdg, judge, 25e6);

        // The desks may not be stocked on the forked block yet (make fund-paxos): make sure 1 TSLA is there.
        StockDesk desk = StockDesk(s.desk);
        if (desk.inventory(s.tokens[0]) < 1e18) deal(s.tokens[0], s.desk, 1e18);

        vm.startPrank(judge);
        GlanceVault vault = _setUpVault(s, judge, 10e6);
        // Re-running changes nothing and doesn't fail.
        GlanceVault again = _setUpVault(s, judge, 0);
        vm.stopPrank();
        assertEq(address(again), address(vault));

        assertEq(vault.owner(), judge);
        assertEq(address(vault.usdg()), s.usdg);
        assertEq(IERC20(s.usdg).balanceOf(address(vault)), 10e6);
        assertTrue(vault.isActiveAgent(s.agent));
        assertTrue(vault.approvedRouters(s.desk));
        for (uint256 i; i < s.tokens.length; ++i) {
            (bool approved, address feed, uint32 open, uint32 closed) = vault.tokenConfig(s.tokens[i]);
            assertTrue(approved);
            assertEq(feed, s.feeds[i]);
            assertEq(open, OPEN_MAX_AGE);
            assertEq(closed, CLOSED_MAX_AGE);
        }

        // The Glance agent buys $10 of TSLA for the judge.
        uint256 quote = desk.quoteBuy(s.tokens[0], 10e6);
        vm.prank(s.agent);
        uint256 got = vault.buy(s.tokens[0], s.desk, 10e6, quote);
        assertEq(got, quote);
        assertEq(IERC20(s.tokens[0]).balanceOf(address(vault)), quote);
        assertEq(IERC20(s.usdg).balanceOf(address(vault)), 0);
    }

    function test_fork_judgeVaultOnRealPaxosUsdg() public {
        _judgeFlow(false);
    }

    function test_fork_judgeVaultOnTestUsdgFallback() public {
        _judgeFlow(true);
    }

    function test_fork_withoutUsdgTheScriptSaysWhereToGetIt() public {
        Setup memory s = _setupFromDeployment(json, false);
        vm.startPrank(judge);
        vm.expectRevert(
            bytes(
                "CreateVault: not enough Paxos USDG. Claim some at https://faucet.paxos.com/ (Robinhood Chain testnet)"
            )
        );
        this.setUpExternal(s, judge, 10e6);
        vm.stopPrank();
    }

    /// @dev expectRevert needs an external call.
    function setUpExternal(Setup memory s, address owner, uint256 deposit) external {
        vm.startPrank(owner);
        _setUpVault(s, owner, deposit);
        vm.stopPrank();
    }
}
