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

interface IV4PoolManager {
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}
interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "ONLY_V4_POOL_MANAGER");
        require(active && v4RouteActive && v4UnlockActive && !v4CallbackSeen, "UNEXPECTED_V4_CALLBACK");
        v4CallbackSeen = true;
        V4SwapData memory p = abi.decode(data, (V4SwapData));
        _validateV4Leg(address(poolManager), p.fee, p.tickSpacing);
        require(approvedToken[p.tokenIn] && approvedToken[p.tokenOut], "V4_TOKEN_NOT_ALLOWED");
        uint256 amountOut = _performV4PoolSwap(p);
        _settleV4Swap(p, amountOut);
        return abi.encode(amountOut);
    }

    function _performV4PoolSwap(V4SwapData memory p) internal returns (uint256 amountOut) {
        bool zeroForOne = uint160(p.tokenIn) < uint160(p.tokenOut);
        IV4PoolManager.PoolKey memory key = IV4PoolManager.PoolKey({
            currency0: zeroForOne ? p.tokenIn : p.tokenOut,
            currency1: zeroForOne ? p.tokenOut : p.tokenIn,
            fee: p.fee,
            tickSpacing: p.tickSpacing,
            hooks: address(0)
        });
        uint160 priceLimit = zeroForOne
            ? 4295128740
            : 1461446703485210103287273052203988822378723970341;
        int256 delta = poolManager.swap(
            key,
            IV4PoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(p.amountIn),
                sqrtPriceLimitX96: priceLimit
            }),
            bytes("")
        );
        amountOut = _validateV4SwapDelta(delta, zeroForOne, p.amountIn, p.minOut);
    }

    function _validateV4SwapDelta(
        int256 packedDelta, bool zeroForOne, uint256 amountIn, uint256 minOut
    ) internal pure returns (uint256 amountOut) {
        int128 delta0 = int128(packedDelta >> 128);
        int128 delta1 = int128(uint128(uint256(packedDelta)));
        int128 inputDelta = zeroForOne ? delta0 : delta1;
        int128 outputDelta = zeroForOne ? delta1 : delta0;
        require(inputDelta < 0 && uint256(uint128(-inputDelta)) == amountIn, "V4_BAD_INPUT_DELTA");
        require(outputDelta > 0, "V4_BAD_OUTPUT_DELTA");
        amountOut = uint256(uint128(outputDelta));
        require(amountOut >= minOut, "V4_MIN_OUT");
    }

    function _settleV4Swap(V4SwapData memory p, uint256 amountOut) internal {
        poolManager.sync(p.tokenIn);
        _safeTransfer(p.tokenIn, address(poolManager), p.amountIn);
        require(poolManager.settle() == p.amountIn, "V4_SETTLEMENT_MISMATCH");
        poolManager.take(p.tokenOut, address(this), amountOut);
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

    function _safeTransfer(address token, address to, uint256 value) internal {
        require(token.code.length > 0 && to != address(0), "BAD_TRANSFER");
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
        require(ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool)))), "TRANSFER_FAILED");
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
