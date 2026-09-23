// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TestUSDG
/// @notice TESTNET STAND-IN. Not Paxos USDG and worth nothing. A 6-decimal dollar token with a public, rate-limited
///         faucet so anyone (including hackathon judges) can fund a Glance vault without asking the team.
/// @dev Deployed only where real USDG cannot be obtained permissionlessly. See docs/CHAIN_NOTES.md.
contract TestUSDG is ERC20, Ownable {
    /// @notice Maximum amount one address can take from the faucet per UTC day (1,000 USDG).
    uint256 public constant FAUCET_DAILY_CAP = 1_000e6;

    /// @notice Amount taken from the faucet by each address, keyed by UTC day number.
    mapping(address account => mapping(uint256 day => uint256 amount)) public faucetMinted;

    /// @notice Emitted on every faucet mint.
    event FaucetMint(address indexed to, uint256 amount, uint256 day);

    /// @notice The request would take the caller over today's faucet allowance.
    error FaucetCapExceeded(uint256 requested, uint256 remainingToday);
    /// @notice Zero amount requested.
    error ZeroAmount();

    /// @param owner_ Address allowed to mint without limit (for seeding the StockDesk).
    constructor(address owner_) ERC20("Glance Test USDG (testnet stand-in)", "USDG") Ownable(owner_) {}

    /// @notice 6 decimals, matching Paxos USDG.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints up to FAUCET_DAILY_CAP per caller per UTC day.
    /// @param amount Raw amount to mint (6 decimals).
    function faucet(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 day = block.timestamp / 1 days;
        uint256 used = faucetMinted[msg.sender][day];
        uint256 remaining = FAUCET_DAILY_CAP - used;
        if (amount > remaining) revert FaucetCapExceeded(amount, remaining);
        faucetMinted[msg.sender][day] = used + amount;
        _mint(msg.sender, amount);
        emit FaucetMint(msg.sender, amount, day);
    }

    /// @notice How much `account` can still take from the faucet today.
    /// @param account Address to check.
    function faucetRemaining(address account) external view returns (uint256) {
        return FAUCET_DAILY_CAP - faucetMinted[account][block.timestamp / 1 days];
    }

    /// @notice Owner mint, used to seed demo inventory.
    /// @param to Recipient.
    /// @param amount Raw amount.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
