// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TestStockToken
/// @notice TESTNET STAND-IN. A mintable ERC-20 standing in for a tokenized stock on chains where no real test Stock
///         Token exists (e.g. Arbitrum Sepolia). Represents no security and is worth nothing.
contract TestStockToken is ERC20, Ownable {
    uint8 private immutable _decimals;

    /// @param name_ Token name. Should make the stand-in status obvious.
    /// @param symbol_ Ticker, e.g. "TSLA".
    /// @param decimals_ Token decimals.
    /// @param owner_ Address allowed to mint.
    constructor(string memory name_, string memory symbol_, uint8 decimals_, address owner_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        _decimals = decimals_;
    }

    /// @notice Token decimals, fixed at deploy.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Owner mint, used to seed demo inventory.
    /// @param to Recipient.
    /// @param amount Raw amount.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
