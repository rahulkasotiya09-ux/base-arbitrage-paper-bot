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

interface IV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Two-hop V2 flash-arbitrage receiver.
/// @dev Still experimental: use only on a fork until independently audited.
contract AaveV3FlashArb {
    address public immutable owner;
    address public immutable wrappedNative;
    IAaveV3Pool public immutable pool;

    mapping(address => bool) public approvedToken;
    mapping(address => bool) public approvedRouter;
    mapping(address => address) public routerFactory;
    mapping(address => uint8) public routerType;

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
        uint24 buyFee;
        uint24 sellFee;
        // Caller-supplied reserve in borrowed-asset units. The executor must
        // calculate this from final calldata L2 + L1 fees with a safety buffer.
        uint256 gasReserveInAsset;
        // Required retained profit after the gas reserve.
        uint256 minProfit;
        uint256 deadline;
    }

    event TokenApproval(address indexed token, bool approved);
    event RouterApproval(address indexed router, bool approved);
    event ArbitrageCompleted(
        address indexed asset,
        address indexed intermediateToken,
        uint256 principal,
        uint256 premium,
        uint256 grossProfit
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier whenIdle() {
        require(!active, "ACTIVE");
        _;
    }

    constructor(address addressesProvider, address ownerAddress, address wrappedNativeAddress) {
        require(addressesProvider != address(0) && addressesProvider.code.length > 0, "BAD_PROVIDER");
        require(ownerAddress != address(0), "ZERO_OWNER");
        require(wrappedNativeAddress != address(0) && wrappedNativeAddress.code.length > 0, "BAD_WRAPPED_NATIVE");
        address poolAddress = IPoolAddressesProvider(addressesProvider).getPool();
        require(poolAddress != address(0) && poolAddress.code.length > 0, "BAD_POOL");
        owner = ownerAddress;
        wrappedNative = wrappedNativeAddress;
        pool = IAaveV3Pool(poolAddress);
    }

    function setToken(address token, bool approved) external onlyOwner whenIdle {
        require(token != address(0) && token.code.length > 0, "BAD_TOKEN");
        approvedToken[token] = approved;
        emit TokenApproval(token, approved);
    }

    function setRouter(address router, bool approved) external onlyOwner whenIdle {
        require(router != address(0) && router.code.length > 0, "BAD_ROUTER");
        if (approved) {
            address factory = IV2Router(router).factory();
            require(factory != address(0) && factory.code.length > 0, "BAD_FACTORY");
            routerFactory[router] = factory;
            routerType[router] = 1;
        } else {
            delete routerFactory[router];
            delete routerType[router];
        }
        approvedRouter[router] = approved;
        emit RouterApproval(router, approved);
    }

    function setV3Router(address router, address factory, bool approved) external onlyOwner whenIdle {
        require(router != address(0) && router.code.length > 0, "BAD_V3_ROUTER");
        if (approved) {
            require(factory != address(0) && factory.code.length > 0, "BAD_V3_FACTORY");
            routerFactory[router] = factory;
            routerType[router] = 2;
        } else {
            delete routerFactory[router];
            delete routerType[router];
        }
        approvedRouter[router] = approved;
        emit RouterApproval(router, approved);
    }

    function start(
        address asset,
        uint256 amount,
        Route calldata route
    ) external onlyOwner whenIdle {
        require(asset == wrappedNative, "ASSET_MUST_BE_WRAPPED_NATIVE");
        require(approvedToken[asset], "ASSET_NOT_ALLOWED");
        require(approvedToken[route.intermediateToken], "MID_NOT_ALLOWED");
        require(asset != route.intermediateToken, "SAME_TOKEN");
        require(approvedRouter[route.buyRouter] && approvedRouter[route.sellRouter], "ROUTER_NOT_ALLOWED");
        require(amount > 0, "ZERO_AMOUNT");
        require(route.minIntermediateOut > 0 && route.minFinalOut > 0, "ZERO_MIN_OUT");
        require(route.gasReserveInAsset > 0, "ZERO_GAS_RESERVE");
        require(route.minProfit > 0, "ZERO_MIN_PROFIT");
        require(route.deadline >= block.timestamp && route.deadline <= block.timestamp + 120, "BAD_DEADLINE");

        loanAsset = asset;
        loanAmount = amount;
        startingBalance = IERC20(asset).balanceOf(address(this));
        active = true;
        callbackSeen = false;

        pool.flashLoanSimple(address(this), asset, amount, abi.encode(route), 0);

        // Aave must have pulled principal + premium before flashLoanSimple returns.
        // Verify the post-repayment balance independently, not only pre-repayment
        // solvency inside executeOperation.
        uint256 requiredResidual = startingBalance + route.gasReserveInAsset + route.minProfit;
        require(IERC20(asset).balanceOf(address(this)) >= requiredResidual, "POST_REPAYMENT_PROFIT_CHECK");
        require(IERC20(asset).allowance(address(this), address(pool)) == 0, "POOL_ALLOWANCE_NOT_CLEARED");
        require(callbackSeen, "NO_CALLBACK");

        active = false;
        loanAsset = address(0);
        loanAmount = 0;
        startingBalance = 0;
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
        require(asset == loanAsset && asset == wrappedNative && amount == loanAmount, "LOAN_MISMATCH");
        callbackSeen = true;

        Route memory r = abi.decode(params, (Route));
        require(approvedToken[asset] && approvedToken[r.intermediateToken], "TOKEN_REVOKED");
        require(approvedRouter[r.buyRouter] && approvedRouter[r.sellRouter], "ROUTER_REVOKED");
        require(r.deadline >= block.timestamp && r.deadline <= block.timestamp + 120, "ROUTE_EXPIRED");

        uint256 midOut = _swap(
            r.buyRouter, asset, r.intermediateToken, amount,
            r.minIntermediateOut, r.deadline, r.buyFee
        );

        _swap(
            r.sellRouter, r.intermediateToken, asset, midOut,
            r.minFinalOut, r.deadline, r.sellFee
        );

        uint256 owed = amount + premium;
        uint256 requiredBalance = startingBalance + owed + r.gasReserveInAsset + r.minProfit;
        uint256 finalBalance = IERC20(asset).balanceOf(address(this));
        require(finalBalance >= requiredBalance, "NOT_PROFITABLE");

        _safeApprove(asset, address(pool), owed);

        // Gross surplus remains in the contract and is withdrawable by the owner.
        // gasReserveInAsset is a profitability gate, not a token fee paid here;
        // the EOA separately pays Base L1/L2 gas.
        emit ArbitrageCompleted(
            asset, r.intermediateToken, amount, premium,
            finalBalance - startingBalance - owed
        );
        return true;
    }

    function _swap(
        address router, address tokenIn, address tokenOut, uint256 amountIn,
        uint256 minOut, uint256 deadline, uint24 fee
    ) internal returns (uint256 actualAmountOut) {
        require(approvedRouter[router] && router.code.length > 0, "BAD_ROUTER");
        uint8 kind = routerType[router];
        require(kind == 1 || kind == 2, "UNKNOWN_ROUTER_TYPE");
        uint256 inputBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outputBefore = IERC20(tokenOut).balanceOf(address(this));
        _safeApprove(tokenIn, router, amountIn);

        if (kind == 1) {
            address factory = IV2Router(router).factory();
            require(factory != address(0) && factory == routerFactory[router] && factory.code.length > 0, "V2_FACTORY_MISMATCH");
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
            uint256[] memory amounts = IV2Router(router).swapExactTokensForTokens(
                amountIn, minOut, path, address(this), deadline
            );
            require(amounts.length == 2 && amounts[1] >= minOut, "BAD_V2_SWAP_RESULT");
        } else {
            require(fee == 500 || fee == 3000 || fee == 10000, "UNSUPPORTED_V3_FEE");
            address v3Pool = IV3Factory(routerFactory[router]).getPool(tokenIn, tokenOut, fee);
            require(v3Pool != address(0) && v3Pool.code.length > 0, "V3_POOL_MISSING");
            uint256 amountOut = IV3SwapRouter(router).exactInputSingle(
                IV3SwapRouter.ExactInputSingleParams({
                    tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, recipient: address(this),
                    amountIn: amountIn, amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            );
            require(amountOut >= minOut, "BAD_V3_SWAP_RESULT");
        }

        uint256 inputAfter = IERC20(tokenIn).balanceOf(address(this));
        uint256 outputAfter = IERC20(tokenOut).balanceOf(address(this));
        require(inputBefore >= inputAfter && inputBefore - inputAfter == amountIn, "BAD_INPUT_DELTA");
        require(outputAfter >= outputBefore, "BAD_OUTPUT_DELTA");
        actualAmountOut = outputAfter - outputBefore;
        require(actualAmountOut >= minOut, "INSUFFICIENT_RECEIVED");
        _safeApprove(tokenIn, router, 0);
    }

    function _safeApprove(address token, address spender, uint256 value) internal {
        require(token.code.length > 0, "TOKEN_NO_CODE");
        // Reset-first approval supports tokens that require zero-before-nonzero.
        (bool ok0, bytes memory ret0) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, 0)
        );
        require(ok0 && (ret0.length == 0 || (ret0.length == 32 && abi.decode(ret0, (bool)))), "APPROVE_RESET_FAILED");

        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, value)
        );
        require(ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool)))), "APPROVE_FAILED");
        require(IERC20(token).allowance(address(this), spender) == value, "APPROVAL_MISMATCH");
    }

    function withdrawToken(address token, address to) external onlyOwner whenIdle {
        require(token != address(0) && token.code.length > 0, "BAD_TOKEN");
        require(to != address(0), "ZERO_TO");
        uint256 bal = IERC20(token).balanceOf(address(this));
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, bal)
        );
        require(ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool)))), "TRANSFER_FAILED");
    }
}
