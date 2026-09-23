// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {GlanceVault} from "./GlanceVault.sol";

/// @title GlanceVaultFactory
/// @notice Deploys one GlanceVault per owner and records it.
contract GlanceVaultFactory {
    /// @dev Owner => vault.
    mapping(address owner => address vault) internal _vaultOf;

    /// @notice Emitted when a vault is created.
    event VaultCreated(address indexed owner, address indexed vault, address indexed usdg);

    /// @notice The caller already has a vault.
    error VaultAlreadyExists(address vault);
    /// @notice USDG address was zero.
    error ZeroAddress();

    /// @notice Deploys a vault owned by the caller.
    /// @param usdg The USDG token the vault will hold.
    /// @return vault The new vault's address.
    function createVault(address usdg) external returns (address vault) {
        if (usdg == address(0)) revert ZeroAddress();
        address existing = _vaultOf[msg.sender];
        if (existing != address(0)) revert VaultAlreadyExists(existing);

        vault = address(new GlanceVault(msg.sender, usdg));
        _vaultOf[msg.sender] = vault;
        emit VaultCreated(msg.sender, vault, usdg);
    }

    /// @notice Returns the vault owned by `owner`, or address(0) if none.
    /// @param owner The vault owner.
    function vaultOf(address owner) external view returns (address) {
        return _vaultOf[owner];
    }
}
