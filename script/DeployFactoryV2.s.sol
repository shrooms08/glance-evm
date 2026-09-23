// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {GlanceVaultFactoryV2} from "../src/GlanceVaultFactoryV2.sol";

/// @title DeployFactoryV2
/// @notice `make deploy-factory-v2`: deploys GlanceVaultFactoryV2 (one-transaction, fully configured, funded vaults).
///         It deploys nothing else and touches nothing: the original GlanceVaultFactory and every vault it created
///         keep working. script/deploy-factory-v2.sh records the address under `factoryV2` in deployments/<chain>.json.
contract DeployFactoryV2 is Script {
    function run() external returns (GlanceVaultFactoryV2 factory) {
        vm.startBroadcast();
        factory = new GlanceVaultFactoryV2();
        vm.stopBroadcast();
        console2.log("GlanceVaultFactoryV2", address(factory));
    }
}
