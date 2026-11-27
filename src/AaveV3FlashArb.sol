// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interfaces; no external library dependency required.
interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

interface IAaveV3Pool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface IV2Router {
    function factory() external view returns (address);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @dev Fork-test starter only. No live deployment is authorized by this code.
///      The contract only supports two V2-style swaps in this initial milestone.
contract AaveV3FlashArb {
    address public immutable owner;
    IAaveV3Pool public immutable pool;

    mapping(address => bool) public approvedToken;
    mapping(address => bool) public approvedRouter;

    bool private active;
    bool private callbackSeen;
    address private loanAsset;
    uint256 private loanAmount;
    uint256 private startingBalance;

    struct Route {
        address intermediateToken;
        address buyRouter;
        address sellRouter;
        uint256 minIntermediateOut;
        uint256 minFinalOut;
        uint256 gasCostInAsset; // caller's conservative gas estimate converted to borrowed-asset units
        uint256 minProfit; // desired profit after reserving gasCostInAsset
        uint256 deadline;
    }

    event TokenApproval(address indexed token, bool approved);
    event RouterApproval(address indexed router, bool approved);
    event ArbitrageCompleted(
        address indexed asset,
        address indexed intermediateToken,
        uint256 principal,
        uint256 premium,
        uint256 contractProfit
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier whenIdle() {
        require(!active, "ACTIVE");
        _;
    }

    constructor(address addressesProvider, address ownerAddress) {
        require(addressesProvider != address(0), "ZERO_PROVIDER");
        require(ownerAddress != address(0), "ZERO_OWNER");
        address poolAddress = IPoolAddressesProvider(addressesProvider).getPool();
        require(poolAddress != address(0) && poolAddress.code.length > 0, "BAD_POOL");
        owner = ownerAddress;
        pool = IAaveV3Pool(poolAddress);
    }

    function setToken(address token, bool approved) external onlyOwner whenIdle {
        require(token != address(0), "ZERO_TOKEN");
        approvedToken[token] = approved;
        emit TokenApproval(token, approved);
    }

    function setRouter(address router, bool approved) external onlyOwner whenIdle {
        require(router != address(0) && router.code.length > 0, "BAD_ROUTER");
        approvedRouter[router] = approved;
        emit RouterApproval(router, approved);
    }

    function start(
        address asset,
        uint256 amount,
        Route calldata route
    ) external onlyOwner whenIdle {
        require(approvedToken[asset], "ASSET_NOT_ALLOWED");
        require(approvedToken[route.intermediateToken], "MID_NOT_ALLOWED");
        require(asset != route.intermediateToken, "SAME_TOKEN");
        require(approvedRouter[route.buyRouter] && approvedRouter[route.sellRouter], "ROUTER_NOT_ALLOWED");
        require(amount > 0, "ZERO_AMOUNT");
        require(route.minIntermediateOut > 0 && route.minFinalOut > 0, "ZERO_MIN_OUT");
        require(route.deadline >= block.timestamp && route.deadline <= block.timestamp + 120, "BAD_DEADLINE");

        loanAsset = asset;
        loanAmount = amount;
        startingBalance = IERC20(asset).balanceOf(address(this));
        active = true;
        callbackSeen = false;

        pool.flashLoanSimple(address(this), asset, amount, abi.encode(route), 0);

        require(callbackSeen, "NO_CALLBACK");
        active = false;
        loanAsset = address(0);
        loanAmount = 0;
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(pool), "ONLY_POOL");
        require(initiator == address(this), "BAD_INITIATOR");
        require(active && !callbackSeen, "UNEXPECTED_CALLBACK");
        require(asset == loanAsset && amount == loanAmount, "LOAN_MISMATCH");
        callbackSeen = true;

        Route memory r = abi.decode(params, (Route));
        require(approvedToken[asset] && approvedToken[r.intermediateToken], "TOKEN_REVOKED");
        require(approvedRouter[r.buyRouter] && approvedRouter[r.sellRouter], "ROUTER_REVOKED");
        require(r.deadline >= block.timestamp && r.deadline <= block.timestamp + 120, "ROUTE_EXPIRED");

        uint256 midOut = _swap(
            r.buyRouter, asset, r.intermediateToken, amount,
            r.minIntermediateOut, r.deadline
        );

        _swap(
            r.sellRouter, r.intermediateToken, asset, midOut,
            r.minFinalOut, r.deadline
        );

        uint256 owed = amount + premium;
        uint256 requiredBalance = startingBalance + owed + r.gasCostInAsset + r.minProfit;
        uint256 finalBalance = IERC20(asset).balanceOf(address(this));
        require(finalBalance >= requiredBalance, "NOT_PROFITABLE");

        _safeApprove(asset, address(pool), owed);

        emit ArbitrageCompleted(
            asset, r.intermediateToken, amount, premium,
            finalBalance - startingBalance - owed - r.gasCostInAsset
        );
        return true;
    }

    function _swap(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        require(approvedRouter[router] && router.code.length > 0, "BAD_ROUTER");
        _safeApprove(tokenIn, router, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts = IV2Router(router).swapExactTokensForTokens(
            amountIn, minOut, path, address(this), deadline
        );
        require(amounts.length == 2 && amounts[1] >= minOut, "BAD_SWAP_RESULT");
        _safeApprove(tokenIn, router, 0);
        return amounts[1];
    }

    function _safeApprove(address token, address spender, uint256 value) internal {
        // Reset-first approval supports tokens that require zero-before-nonzero.
        (bool ok0, bytes memory ret0) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, 0)
        );
        require(ok0 && (ret0.length == 0 || abi.decode(ret0, (bool))), "APPROVE_RESET_FAILED");

        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, value)
        );
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "APPROVE_FAILED");
    }

    function withdrawToken(address token, address to) external onlyOwner whenIdle {
        require(token != address(0), "ZERO_TOKEN");
        require(to != address(0), "ZERO_TO");
        uint256 bal = IERC20(token).balanceOf(address(this));
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, bal)
        );
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "TRANSFER_FAILED");
    }
}
