// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title RevenueVault
 * @notice Generic withdrawal vault used by the ANS ecosystem for isolated namespace revenue custody.
 * @dev Trust boundary: each namespace vault is owned independently, so withdrawing revenue from one namespace never grants authority over another.
 */
contract RevenueVault is Ownable {
    using SafeERC20 for IERC20;

    error InvalidRecipient(address recipient);
    error InvalidToken(address token);

    /**
     * @notice Emitted when tokens are withdrawn from the vault.
     * @param token The token address withdrawn.
     * @param to The withdrawal recipient.
     * @param amount The amount withdrawn.
     */
    event Withdrawal(address indexed token, address indexed to, uint256 amount);

    /**
     * @notice Creates a revenue vault.
     * @param initialOwner The vault owner.
     */
    constructor(address initialOwner) Ownable(initialOwner) {}

    /**
     * @notice Withdraws tokens from the vault.
     * @param token The token address to withdraw.
     * @param to The address receiving the withdrawal.
     * @param amount The amount to withdraw.
     */
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            revert InvalidToken(address(0));
        }
        if (to == address(0)) {
            revert InvalidRecipient(address(0));
        }

        IERC20(token).safeTransfer(to, amount);
        emit Withdrawal(token, to, amount);
    }
}