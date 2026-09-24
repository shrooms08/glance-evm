// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ConfiguredGlanceVault, VaultConfig} from "./ConfiguredGlanceVault.sol";

/// @title GlanceVaultFactoryV2
/// @notice One transaction to a fully configured, funded vault: deploys a ConfiguredGlanceVault owned by the caller,
///         with every setting applied and `depositAmount` USDG moved in from the caller (who approves this factory
///         first; zero skips the deposit). One vault per owner, as in GlanceVaultFactory, which keeps working.
/// @dev The factory never holds rights over a vault: the vault's owner is immutable and set to msg.sender in its
///      constructor; USDG goes from the caller straight to the vault's precomputed CREATE2 address (never through
///      the factory); the factory never approves anything. A failed setting reverts the whole transaction, including
///      the transfer.
contract GlanceVaultFactoryV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Owner => vault.
    mapping(address owner => address vault) internal _vaultOf;

    /// @notice Emitted when a vault is created.
    event VaultCreated(address indexed owner, address indexed vault, address indexed usdg);

    /// @notice The caller already has a vault from this factory.
    error VaultAlreadyExists(address vault);
    /// @notice USDG address was zero.
    error ZeroAddress();
    /// @notice The owner's transfer delivered less USDG than the deposit (a fee-on-transfer or otherwise short token).
    error DepositShortfall(uint256 received, uint256 expected);

    /// @notice Deploys a vault owned by the caller, configured with `config` and funded with `depositAmount`.
    /// @param config Every setting, validated exactly as the vault's owner setters validate them.
    /// @param depositAmount Raw USDG to move from the caller into the vault (needs a prior approve to this factory).
    /// @return vault The new vault's address.
    function createVaultWithConfig(VaultConfig calldata config, uint256 depositAmount)
        external
        nonReentrant
        returns (address vault)
    {
        if (config.usdg == address(0)) revert ZeroAddress();
        address existing = _vaultOf[msg.sender];
        if (existing != address(0)) revert VaultAlreadyExists(existing);

        bytes32 salt = _salt(msg.sender);
        address predicted = _predict(msg.sender, config, depositAmount, salt);
        _vaultOf[msg.sender] = predicted;

        if (depositAmount != 0) {
            // Measure what the owner's transfer delivered, not what the address holds: a donation made before this
            // transaction can neither break creation nor hide a short delivery.
            IERC20 usdg = IERC20(config.usdg);
            uint256 before = usdg.balanceOf(predicted);
            usdg.safeTransferFrom(msg.sender, predicted, depositAmount);
            uint256 received = usdg.balanceOf(predicted) - before;
            if (received < depositAmount) revert DepositShortfall(received, depositAmount);
        }

        vault = address(new ConfiguredGlanceVault{salt: salt}(msg.sender, config, depositAmount));
        // Unreachable unless the compiler's CREATE2 disagrees with the formula: never leave funds at a wrong address.
        assert(vault == predicted);
        emit VaultCreated(msg.sender, vault, config.usdg);
    }

    /// @notice The address createVaultWithConfig would deploy `owner`'s vault to with these arguments.
    function predictVault(address owner, VaultConfig calldata config, uint256 depositAmount)
        external
        view
        returns (address)
    {
        return _predict(owner, config, depositAmount, _salt(owner));
    }

    /// @notice Returns the vault owned by `owner`, or address(0) if none.
    /// @param owner The vault owner.
    function vaultOf(address owner) external view returns (address) {
        return _vaultOf[owner];
    }

    function _salt(address owner) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(owner)));
    }

    function _predict(address owner, VaultConfig calldata config, uint256 depositAmount, bytes32 salt)
        internal
        view
        returns (address)
    {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(ConfiguredGlanceVault).creationCode, abi.encode(owner, config, depositAmount))
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}
