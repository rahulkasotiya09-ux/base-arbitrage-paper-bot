// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// UNAUDITED. Use a mainnet fork and independent security review before deployment.
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IBalancerVault {
    function flashLoan(address recipient, IERC20[] memory tokens, uint256[] memory amounts, bytes memory userData) external;
}
interface IBalancerV2Router {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts);
}

/// @notice Owner-operated two-router Balancer flash-loan arbitrage executor.
/// @dev V2-style routers only. Balancer fees are read from the callback, never assumed to be zero.
contract FlashArbBalancerImproved {
    using SafeERC20 for IERC20;

    IBalancerVault public constant VAULT = IBalancerVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    address public immutable owner;
    mapping(address => bool) public approvedRouter;
    bool private active;
    bool private callbackSeen;
    address private expectedAsset;
    uint256 private expectedAmount;
    uint256 private startingBalance;

    struct Params {
        address buyRouter;
        address sellRouter;
        address intermediateToken;
        uint256 minIntermediateOut;
        uint256 minBaseOut;
        uint256 minProfit; // borrowed-asset units; excludes gas costs
        uint256 deadline;
    }

    event RouterApproval(address indexed router, bool approved);
    event ArbitrageExecuted(address indexed asset, address indexed intermediateToken, uint256 amount, uint256 fee, uint256 profit);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier whenIdle() { require(!active, "execution active"); _; }

    constructor() { owner = msg.sender; }

    function setRouter(address router, bool approved) external onlyOwner whenIdle {
        require(router != address(0) && router.code.length > 0, "invalid router");
        approvedRouter[router] = approved;
        emit RouterApproval(router, approved);
    }

    function execute(address baseAsset, uint256 amount, Params calldata p) external onlyOwner whenIdle {
        require(baseAsset != address(0) && amount > 0, "invalid loan");
        require(p.intermediateToken != address(0) && p.intermediateToken != baseAsset, "invalid intermediate");
        require(approvedRouter[p.buyRouter] && approvedRouter[p.sellRouter], "router not approved");
        require(p.minIntermediateOut > 0 && p.minBaseOut > 0, "zero min output");
        require(p.deadline >= block.timestamp, "expired route");

        expectedAsset = baseAsset;
        expectedAmount = amount;
        startingBalance = IERC20(baseAsset).balanceOf(address(this));
        active = true;
        callbackSeen = false;

        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(baseAsset);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        VAULT.flashLoan(address(this), tokens, amounts, abi.encode(p));

        require(callbackSeen, "callback not received");
        active = false;
        expectedAsset = address(0);
        expectedAmount = 0;
    }

    function receiveFlashLoan(IERC20[] memory tokens, uint256[] memory amounts, uint256[] memory fees, bytes memory userData) external {
        require(msg.sender == address(VAULT) && active && !callbackSeen, "unauthorized callback");
        require(tokens.length == 1 && amounts.length == 1 && fees.length == 1, "unexpected loan shape");
        require(address(tokens[0]) == expectedAsset && amounts[0] == expectedAmount, "unexpected loan");
        callbackSeen = true;

        Params memory p = abi.decode(userData, (Params));
        require(approvedRouter[p.buyRouter] && approvedRouter[p.sellRouter], "router not approved");
        require(p.deadline >= block.timestamp, "route expired");

        uint256 midOut = _swap(p.buyRouter, expectedAsset, p.intermediateToken, amounts[0], p.minIntermediateOut, p.deadline);
        _swap(p.sellRouter, p.intermediateToken, expectedAsset, midOut, p.minBaseOut, p.deadline);

        uint256 owed = amounts[0] + fees[0];
        uint256 balanceAfterSwaps = IERC20(expectedAsset).balanceOf(address(this));
        require(balanceAfterSwaps >= startingBalance + owed + p.minProfit, "insufficient net contract profit");
        IERC20(expectedAsset).safeTransfer(address(VAULT), owed);
        emit ArbitrageExecuted(expectedAsset, p.intermediateToken, amounts[0], fees[0], balanceAfterSwaps - startingBalance - owed);
    }

    function _swap(address router, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 deadline)
        internal returns (uint256 amountOut)
    {
        require(approvedRouter[router] && router.code.length > 0, "unapproved router");
        IERC20(tokenIn).forceApprove(router, amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn; path[1] = tokenOut;
        uint256[] memory amounts = IBalancerV2Router(router).swapExactTokensForTokens(amountIn, minOut, path, address(this), deadline);
        IERC20(tokenIn).forceApprove(router, 0);
        require(amounts.length == 2 && amounts[1] >= minOut, "bad swap output");
        amountOut = amounts[1];
    }

    function withdraw(address token) external onlyOwner whenIdle {
        require(token != address(0), "zero token");
        IERC20(token).safeTransfer(owner, IERC20(token).balanceOf(address(this)));
    }
}
