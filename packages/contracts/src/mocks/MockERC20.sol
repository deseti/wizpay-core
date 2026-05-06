// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockERC20 {
    error InsufficientAllowance();
    error InsufficientBalance();
    error ZeroAddress();

    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply
    ) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        _mint(msg.sender, initialSupply);
    }

    /**
     * @notice Transfers tokens from the caller to a recipient.
     * @param to Recipient address.
     * @param amount Token amount to transfer.
     * @return True when the transfer succeeds.
     */
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    /**
     * @notice Sets the allowance for a spender.
     * @param spender Approved spender.
     * @param amount Allowance amount.
     * @return True when the approval succeeds.
     */
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /**
     * @notice Transfers tokens using the allowance mechanism.
     * @param from Token owner.
     * @param to Recipient address.
     * @param amount Token amount to transfer.
     * @return True when the transfer succeeds.
     */
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (balanceOf[from] < amount) revert InsufficientBalance();

        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }

        _transfer(from, to, amount);
        return true;
    }

    /**
     * @notice Mints tokens to a target address.
     * @param to Recipient address.
     * @param amount Token amount to mint.
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();

        totalSupply += amount;
        balanceOf[to] += amount;

        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();

        balanceOf[from] -= amount;
        balanceOf[to] += amount;

        emit Transfer(from, to, amount);
    }
}
