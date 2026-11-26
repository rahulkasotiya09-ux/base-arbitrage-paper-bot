// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// UNAUDITED. Use a mainnet fork and independent security review before deployment.
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAaveV3Pool {
    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
}
interface IUniV2Router {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts);
}
interface IUniV3Router02 {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut);
}

/// @notice Owner-operated, two-leg Aave V3 flash-loan arbitrage executor.
/// @dev fee==0 selects a V2-style router; fee>0 selects a V3 SwapRouter02-style router.
///      Router addresses must be explicitly allowlisted by the owner.
contract FlashArbMultiImproved {
    using SafeERC20 for IERC20;

    address public immutable owner;
    IAaveV3Pool public immutable pool;
    mapping(address => bool) public approvedRouter;
    bool private active;
    bool private callbackSeen;

    struct Route {
        address tokenMid;
        address buyRouter;
        uint24 buyFee;
        address sellRouter;
        uint24 sellFee;
        uint256 minMidOut;
        uint256 minBaseOut;
        uint256 minProfit; // denominated in borrowed asset; excludes gas costs
        uint256 deadline;
    }

    event RouterApproval(address indexed router, bool approved);
    event ArbitrageExecuted(address indexed asset, address indexed intermediateToken, uint256 amount, uint256 premium, uint256 profit);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier whenIdle() { require(!active, "execution active"); _; }

    constructor(address aavePool) {
        require(aavePool != address(0), "zero pool");
        owner = msg.sender;
        pool = IAaveV3Pool(aavePool);
    }

    function setRouter(address router, bool approved) external onlyOwner whenIdle {
        require(router != address(0) && router.code.length > 0, "invalid router");
        approvedRouter[router] = approved;
        emit RouterApproval(router, approved);
    }

    function start(address asset, uint256 amount, Route calldata route) external onlyOwner whenIdle {
        require(asset != address(0) && amount > 0, "invalid loan");
        require(route.tokenMid != address(0) && route.tokenMid != asset, "invalid intermediate token");
        require(approvedRouter[route.buyRouter] && approvedRouter[route.sellRouter], "router not approved");
        require(route.buyRouter != address(0) && route.sellRouter != address(0), "zero router");
        require(route.minMidOut > 0 && route.minBaseOut > 0, "zero min output");
        require(route.deadline >= block.timestamp, "expired route");

        active = true;
        callbackSeen = false;
        pool.flashLoanSimple(address(this), asset, amount, abi.encode(route), 0);
        require(callbackSeen, "callback not received");
        active = false;
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external returns (bool)
    {
        require(active && !callbackSeen, "unexpected callback");
        require(msg.sender == address(pool) && initiator == address(this), "unauthorized callback");
        callbackSeen = true;
        Route memory r = abi.decode(params, (Route));
        require(approvedRouter[r.buyRouter] && approvedRouter[r.sellRouter], "router not approved");
        require(r.deadline >= block.timestamp, "route expired");

        uint256 balanceNow = IERC20(asset).balanceOf(address(this));
        require(balanceNow >= amount, "loan not received");
        uint256 startingBalance = balanceNow - amount;

        uint256 intermediateOut = _swap(r.buyRouter, asset, r.tokenMid, r.buyFee, amount, r.minMidOut, r.deadline);
        _swap(r.sellRouter, r.tokenMid, asset, r.sellFee, intermediateOut, r.minBaseOut, r.deadline);

        uint256 owed = amount + premium;
        uint256 finalBalance = IERC20(asset).balanceOf(address(this));
        require(finalBalance >= startingBalance + owed + r.minProfit, "insufficient net contract profit");

        IERC20(asset).forceApprove(address(pool), owed);
        emit ArbitrageExecuted(asset, r.tokenMid, amount, premium, finalBalance - startingBalance - owed);
        return true;
    }

    function _swap(address router, address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut, uint256 deadline)
        internal returns (uint256 amountOut)
    {
        require(approvedRouter[router] && router.code.length > 0, "unapproved router");
        IERC20(tokenIn).forceApprove(router, amountIn);
        if (fee == 0) {
            address[] memory path = new address[](2);
            path[0] = tokenIn; path[1] = tokenOut;
            uint256[] memory amounts = IUniV2Router(router).swapExactTokensForTokens(amountIn, minOut, path, address(this), deadline);
            require(amounts.length == 2, "bad V2 response");
            amountOut = amounts[1];
        } else {
            amountOut = IUniV3Router02(router).exactInputSingle(
                IUniV3Router02.ExactInputSingleParams(tokenIn, tokenOut, fee, address(this), amountIn, minOut, 0)
            );
        }
        IERC20(tokenIn).forceApprove(router, 0);
        require(amountOut >= minOut, "output below minimum");
    }

    function withdraw(address token) external onlyOwner whenIdle {
        require(token != address(0), "zero token");
        IERC20(token).safeTransfer(owner, IERC20(token).balanceOf(address(this)));
    }
}
