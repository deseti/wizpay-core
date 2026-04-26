// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IFXEngine.sol";

/**
 * @title StableFXAdapter (SFX-LP)
 * @dev Decentralized Adapter contract bridging WizPay with cross-stablecoin liquidity
 * 
 * Features:
 * - Unified Liquidity Pool (ERC20 Token Vault model)
 * - Users earn fees by providing liquidity in exchange for SFX-LP tokens
 * - Automated 0.25% internal swap fee distributed to LP stakers
 * - Dynamic TVL pricing oracle
 */
contract StableFXAdapter_V2 is IFXEngine, ERC20, Ownable {
    // Exchange rate oracle (18 decimals: 1e18 = 1:1 rate)
    mapping(address => mapping(address => uint256)) public exchangeRates;
    
    // Rate validity period
    mapping(address => mapping(address => uint256)) public rateTimestamps;
    uint256 public constant RATE_VALIDITY = 31536000; // 1 year
    
    // Slippage tracking
    uint256 public slippageTolerance = 50; // 0.5%
    uint256 public constant MAX_SLIPPAGE = 500; // 5%

    // Liquidity Pool Mechanics
    uint256 public lpFeeBps = 25; // 0.25% fee distributed to LP pool
    address public baseAsset; // Base token used to calculate total TVL (e.g. USDC)
    
    address[] public acceptedTokens;
    mapping(address => bool) public isAcceptedToken;
    
    // Events
    event ExchangeRateUpdated(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 rate,
        uint256 timestamp
    );
    
    event SwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 rate,
        uint256 lpFee
    );
    
    event LiquidityAdded(address indexed token, uint256 amountIn, uint256 sharesMinted);
    event LiquidityRemoved(address indexed token, uint256 amountOut, uint256 sharesBurned);
    event AcceptedTokenAdded(address indexed token);
    
    constructor(address initialOwner, address _baseAsset) 
        ERC20("StableFX Liquidity Provider", "SFX-LP") 
        Ownable(initialOwner) 
    {
        require(_baseAsset != address(0), "StableFXAdapter: Invalid base asset");
        baseAsset = _baseAsset;
    }

    /**
     * @dev SFX-LP decimals matches the base stablecoin (6 decimals)
     */
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /**
     * @dev Add supported token to the LP Pool
     */
    function addAcceptedToken(address token) external onlyOwner {
        require(!isAcceptedToken[token], "StableFXAdapter: Token already tracked");
        isAcceptedToken[token] = true;
        acceptedTokens.push(token);
        emit AcceptedTokenAdded(token);
    }

    /**
     * @dev Calculates the Total Value Locked (TVL) across all accepted tokens
     * Normalized to the `baseAsset` scale using Oracle Exchange Rates
     */
    function getTVL() public view returns (uint256 totalValue) {
        for (uint256 i = 0; i < acceptedTokens.length; i++) {
            address token = acceptedTokens[i];
            uint256 balance = IERC20(token).balanceOf(address(this));
            
            if (balance > 0) {
                totalValue += getEstimatedAmountInternal(token, baseAsset, balance);
            }
        }
        return totalValue;
    }

    /**
     * @dev Provides Liquidity: User sends token, receives SFX-LP shares proportional to pool TVL
     */
    function addLiquidity(address token, uint256 amount) external {
        require(isAcceptedToken[token], "StableFXAdapter: Token not accepted in pool");
        require(amount > 0, "StableFXAdapter: Invalid amount");
        
        uint256 tvlBefore = getTVL();
        
        require(
            IERC20(token).transferFrom(msg.sender, address(this), amount),
            "StableFXAdapter: Transfer failed"
        );
        
        uint256 valueAdded = getEstimatedAmountInternal(token, baseAsset, amount);
        uint256 sharesToMint = 0;
        
        if (totalSupply() == 0) {
            sharesToMint = valueAdded; // Initialize 1:1 (assuming base asset decimals is compatible or 18)
        } else {
            require(tvlBefore > 0, "StableFXAdapter: TVL zero error");
            sharesToMint = (valueAdded * totalSupply()) / tvlBefore;
        }
        
        require(sharesToMint > 0, "StableFXAdapter: Zero shares minted");
        _mint(msg.sender, sharesToMint);
        
        emit LiquidityAdded(token, amount, sharesToMint);
    }

    /**
     * @dev Removes Liquidity: User burns SFX-LP shares to withdraw a target token
     */
    function removeLiquidity(address targetToken, uint256 shares) external {
        require(isAcceptedToken[targetToken], "StableFXAdapter: Token not accepted in pool");
        require(shares > 0 && shares <= balanceOf(msg.sender), "StableFXAdapter: Insufficient shares");
        
        uint256 currentTvl = getTVL();
        // TVL value the shares represent
        uint256 valueToWithdraw = (shares * currentTvl) / totalSupply();
        
        // Convert the baseAsset-normalized value back to targetToken
        uint256 amountToWithdraw = getEstimatedAmountInternal(baseAsset, targetToken, valueToWithdraw);
        
        uint256 available = IERC20(targetToken).balanceOf(address(this));
        require(available >= amountToWithdraw, "StableFXAdapter: Insufficient token liquidity");
        
        _burn(msg.sender, shares);
        
        require(
            IERC20(targetToken).transfer(msg.sender, amountToWithdraw),
            "StableFXAdapter: Transfer failed"
        );
        
        emit LiquidityRemoved(targetToken, amountToWithdraw, shares);
    }

    /**
     * @dev Update exchange rate for a token pair
     */
    function setExchangeRate(
        address tokenIn,
        address tokenOut,
        uint256 rate
    ) external onlyOwner {
        require(tokenIn != address(0) && tokenOut != address(0), "StableFXAdapter: Invalid token");
        require(rate > 0, "StableFXAdapter: Invalid rate");
        
        exchangeRates[tokenIn][tokenOut] = rate;
        rateTimestamps[tokenIn][tokenOut] = block.timestamp;
        
        emit ExchangeRateUpdated(tokenIn, tokenOut, rate, block.timestamp);
    }

    function getExchangeRate(
        address tokenIn,
        address tokenOut
    ) public view returns (uint256 rate) {
        if (tokenIn == tokenOut) {
            return 1e18; // 1:1
        }
        
        rate = exchangeRates[tokenIn][tokenOut];
        require(rate > 0, "StableFXAdapter: Rate not configured");
        
        uint256 rateAge = block.timestamp - rateTimestamps[tokenIn][tokenOut];
        require(rateAge <= RATE_VALIDITY, "StableFXAdapter: Rate expired");
        
        return rate;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) external override returns (uint256 amountOut) {
        require(amountIn > 0, "StableFXAdapter: Invalid amount");
        require(tokenIn != tokenOut, "StableFXAdapter: Same token");
        
        uint256 rate = getExchangeRate(tokenIn, tokenOut);
        
        uint256 tokenInDecimals = getTokenDecimals(tokenIn);
        uint256 tokenOutDecimals = getTokenDecimals(tokenOut);
        
        // Base calculation
        amountOut = (amountIn * rate) / 1e18;
        
        // Adjust decimals
        if (tokenInDecimals > tokenOutDecimals) {
            amountOut = amountOut / (10 ** (tokenInDecimals - tokenOutDecimals));
        } else if (tokenOutDecimals > tokenInDecimals) {
            amountOut = amountOut * (10 ** (tokenOutDecimals - tokenInDecimals));
        }
        
        // Take LP Fee (Fee stays in contract thereby increasing Pool TVL)
        uint256 lpFee = (amountOut * lpFeeBps) / 10000;
        amountOut = amountOut - lpFee;

        require(amountOut >= minAmountOut, "StableFXAdapter: Slippage exceeded");
        
        uint256 availableLiquidity = IERC20(tokenOut).balanceOf(address(this));
        require(
            availableLiquidity >= amountOut,
            "StableFXAdapter: Insufficient pool liquidity"
        );
        
        require(
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn),
            "StableFXAdapter: Transfer in failed"
        );
        
        require(
            IERC20(tokenOut).transfer(to, amountOut),
            "StableFXAdapter: Transfer out failed"
        );
        
        emit SwapExecuted(tokenIn, tokenOut, amountIn, amountOut, rate, lpFee);
        return amountOut;
    }

    function getEstimatedAmount(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view override returns (uint256 estimatedAmountOut) {
        uint256 baseExpected = getEstimatedAmountInternal(tokenIn, tokenOut, amountIn);
        // deduct LP fee for exact public estimate
        if (tokenIn != tokenOut) {
            uint256 lpFee = (baseExpected * lpFeeBps) / 10000;
            return baseExpected - lpFee;
        }
        return baseExpected;
    }

    // Internal helper without fee deduction used for TVL calculations
    function getEstimatedAmountInternal(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal view returns (uint256 estimatedAmountOut) {
        if (tokenIn == tokenOut) return amountIn;
        
        uint256 rate = getExchangeRate(tokenIn, tokenOut);
        
        uint256 tokenInDecimals = getTokenDecimals(tokenIn);
        uint256 tokenOutDecimals = getTokenDecimals(tokenOut);
        
        estimatedAmountOut = (amountIn * rate) / 1e18;
        
        if (tokenInDecimals > tokenOutDecimals) {
            estimatedAmountOut = estimatedAmountOut / (10 ** (tokenInDecimals - tokenOutDecimals));
        } else if (tokenOutDecimals > tokenInDecimals) {
            estimatedAmountOut = estimatedAmountOut * (10 ** (tokenOutDecimals - tokenInDecimals));
        }
        
        return estimatedAmountOut;
    }

    function getTokenDecimals(address token) internal view returns (uint256) {
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        if (success && data.length >= 32) {
            return abi.decode(data, (uint256));
        }
        return 6; // Default ARC stables
    }

    function updateLpFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= 500, "StableFXAdapter: Fee too high"); // max 5%
        lpFeeBps = newFeeBps;
    }

    /**
     * @dev Emergency recovery for unexpected tokens (does not allow draining accepted LP tokens)
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        require(!isAcceptedToken[token], "StableFXAdapter: Cannot withdraw LP tokens directly");
        require(
            IERC20(token).transfer(owner(), amount),
            "StableFXAdapter: Withdrawal failed"
        );
    }
}
