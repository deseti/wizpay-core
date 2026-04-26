// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPermit2
 * @dev Simplified interface for Uniswap's Permit2 contract
 * Used by StableFX and other protocols for advanced allowance management
 * 
 * Full Permit2 contract address: 0x000000000022D473030F116dDEE9F6B43aC78BA3
 * Available on ARC Testnet and most EVM chains
 */
interface IPermit2 {
    /**
     * @notice The token and amount details for a transfer signed in the permit transfer signature
     */
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    /**
     * @notice The signed permit message for a single token transfer
     */
    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    /**
     * @notice Transfers a token using a signed permit message
     * @param permit The permit data signed over by the owner
     * @param to The recipient address
     * @param amount The amount to transfer
     * @param owner The owner of the tokens being transferred
     * @param signature The signature to verify
     */
    function permitTransferFrom(
        PermitTransferFrom memory permit,
        address to,
        uint256 amount,
        address owner,
        bytes calldata signature
    ) external;

    /**
     * @notice Approve token allowance for a spender
     * @param token The token to approve
     * @param spender The spender to approve
     * @param amount The amount to approve
     * @param expiration The expiration timestamp for the allowance
     */
    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration
    ) external;

    /**
     * @notice Get the allowance for a token/owner/spender combination
     * @param owner The owner of the tokens
     * @param token The token address
     * @param spender The spender address
     * @return amount The allowed amount
     * @return expiration The expiration timestamp
     * @return nonce The current nonce
     */
    function allowance(
        address owner,
        address token,
        address spender
    ) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
}
