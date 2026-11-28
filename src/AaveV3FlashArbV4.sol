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
interface IAerodromeFactory {
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address);
}
interface IAerodromeRouter {
    struct Route { address from; address to; bool stable; address factory; }
    function defaultFactory() external view returns (address);
    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, Route[] calldata routes, address to, uint256 deadline
    ) external returns (uint256[] memory amounts);
}
interface ISlipstreamFactory {
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address);
}
interface ISlipstreamRouter {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; int24 tickSpacing; address recipient;
        uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function factory() external view returns (address);
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
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// @notice Two-hop V2/V3/V4 Aave flash-arbitrage receiver.
/// @dev Still experimental: use only on a fork until independently audited.
contract AaveV3FlashArbV4 is IUnlockCallback {
    address public immutable owner;
    address public immutable wrappedNative;
    IAaveV3Pool public immutable pool;
    IV4PoolManager public immutable poolManager;

    mapping(address => bool) public approvedToken;
    mapping(address => bool) public approvedRouter;
    mapping(address => address) public routerFactory;
    mapping(address => uint8) public routerType;

    bool private active;
    bool private callbackSeen;
    address private loanAsset;
    uint256 private loanAmount;
    uint256 private startingBalance;
    bool private v4RouteActive;
    bool private multiRouteActive;
    bool private v4UnlockActive;
    bool private v4CallbackSeen;

    struct RouteLegacy {
        address intermediateToken;
        address buyRouter;
        address sellRouter;
        uint256 minIntermediateOut;
        uint256 minFinalOut;
        uint256 gasReserveInAsset;
        uint256 minProfit;
        uint256 deadline;
    }

    struct Route {
        address intermediateToken;
        address buyRouter;
        address sellRouter;
        uint256 minIntermediateOut;
        uint256 minFinalOut;
        uint24 buyFee;
        uint24 sellFee;
        uint256 gasReserveInAsset;
        uint256 minProfit;
        uint256 deadline;
    }

    struct RouteMulti {
        address intermediateToken;
        address buyRouter;
        address sellRouter;
        uint256 minIntermediateOut;
        uint256 minFinalOut;
        uint24 buyFee;
        uint24 sellFee;
        int24 buyTickSpacing;
        int24 sellTickSpacing;
        bool buyStable;
        bool sellStable;
        uint256 gasReserveInAsset;
        uint256 minProfit;
        uint256 deadline;
    }

    struct SwapRequest {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        uint256 deadline;
    }

    struct V4SwapData {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        uint24 fee;
        int24 tickSpacing;
    }

    struct RouteV4 {
        address intermediateToken;
        address buyRouter;
        address sellRouter;
        uint256 minIntermediateOut;
        uint256 minFinalOut;
        uint24 buyFee;
        uint24 sellFee;
        int24 buyTickSpacing;
        int24 sellTickSpacing;
        uint256 gasReserveInAsset;
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

    constructor(address addressesProvider, address ownerAddress, address wrappedNativeAddress, address poolManagerAddress) {
        require(addressesProvider != address(0) && addressesProvider.code.length > 0, "BAD_PROVIDER");
        require(ownerAddress != address(0), "ZERO_OWNER");
        require(wrappedNativeAddress != address(0) && wrappedNativeAddress.code.length > 0, "BAD_WRAPPED_NATIVE");
        require(poolManagerAddress != address(0) && poolManagerAddress.code.length > 0, "BAD_V4_POOL_MANAGER");
        address poolAddress = IPoolAddressesProvider(addressesProvider).getPool();
        require(poolAddress != address(0) && poolAddress.code.length > 0, "BAD_POOL");
        owner = ownerAddress;
        wrappedNative = wrappedNativeAddress;
        pool = IAaveV3Pool(poolAddress);
        poolManager = IV4PoolManager(poolManagerAddress);
        approvedRouter[poolManagerAddress] = true;
        routerType[poolManagerAddress] = 3;
    }

    function setToken(address token, bool approved) external onlyOwner whenIdle {
        require(token != address(0) && token.code.length > 0, "BAD_TOKEN");
        approvedToken[token] = approved;
        emit TokenApproval(token, approved);
    }

    function setRouter(address router, bool approved) external onlyOwner whenIdle {
        require(router != address(0) && router != address(poolManager) && router.code.length > 0, "BAD_ROUTER");
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
        require(router != address(0) && router != address(poolManager) && router.code.length > 0, "BAD_V3_ROUTER");
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

    function setAerodromeRouter(address router, address factory, bool approved) external onlyOwner whenIdle {
        require(router != address(0) && router.code.length > 0, "BAD_AERODROME_ROUTER");
        if (approved) {
            require(factory != address(0) && factory.code.length > 0, "BAD_AERODROME_FACTORY");
            require(IAerodromeRouter(router).defaultFactory() == factory, "AERODROME_FACTORY_MISMATCH");
            routerFactory[router] = factory;
            routerType[router] = 4;
        } else {
            delete routerFactory[router];
            delete routerType[router];
        }
        approvedRouter[router] = approved;
        emit RouterApproval(router, approved);
    }

    function setSlipstreamRouter(address router, address factory, bool approved) external onlyOwner whenIdle {
        require(router != address(0) && router.code.length > 0, "BAD_SLIPSTREAM_ROUTER");
        if (approved) {
            require(factory != address(0) && factory.code.length > 0, "BAD_SLIPSTREAM_FACTORY");
            require(ISlipstreamRouter(router).factory() == factory, "SLIPSTREAM_FACTORY_MISMATCH");
            routerFactory[router] = factory;
            routerType[router] = 5;
        } else {
            delete routerFactory[router];
            delete routerType[router];
        }
        approvedRouter[router] = approved;
        emit RouterApproval(router, approved);
    }

    // Unified route selector supports mixed V2/V3/V4/Aerodrome/Slipstream legs.
    function startMulti(address asset, uint256 amount, RouteMulti calldata route) external onlyOwner whenIdle {
        _validateMultiLeg(route.buyRouter, route.intermediateToken, asset, route.buyFee, route.buyTickSpacing, route.buyStable);
        _validateMultiLeg(route.sellRouter, asset, route.intermediateToken, route.sellFee, route.sellTickSpacing, route.sellStable);
        require(asset == wrappedNative && approvedToken[asset], "ASSET_NOT_ALLOWED");
        require(approvedToken[route.intermediateToken] && route.intermediateToken != asset, "MID_NOT_ALLOWED");
        require(amount > 0 && route.minIntermediateOut > 0 && route.minFinalOut > 0, "BAD_AMOUNT_OR_MIN_OUT");
        require(route.gasReserveInAsset > 0 && route.minProfit > 0, "BAD_PROFIT_GUARD");
        require(route.deadline >= block.timestamp && route.deadline <= block.timestamp + 120, "BAD_DEADLINE");
        require(approvedRouter[route.buyRouter] && approvedRouter[route.sellRouter], "ROUTER_NOT_ALLOWED");
        loanAsset = asset;
        loanAmount = amount;
        startingBalance = IERC20(asset).balanceOf(address(this));
        active = true;
        callbackSeen = false;
        multiRouteActive = true;
        v4RouteActive = true;
        pool.flashLoanSimple(address(this), asset, amount, abi.encode(route), 0);
        require(callbackSeen, "NO_CALLBACK");
        require(IERC20(asset).balanceOf(address(this)) >= startingBalance + route.gasReserveInAsset + route.minProfit, "POST_REPAYMENT_PROFIT_CHECK");
        require(IERC20(asset).allowance(address(this), address(pool)) == 0, "POOL_ALLOWANCE_NOT_CLEARED");
        active = false;
        multiRouteActive = false;
        v4RouteActive = false;
        loanAsset = address(0);
        loanAmount = 0;
        startingBalance = 0;
    }

    // Legacy selector retained so the already-deployed V2 executor remains usable.
    function start(address asset, uint256 amount, RouteLegacy calldata legacy) external onlyOwner whenIdle {
        Route memory route = Route({
            intermediateToken: legacy.intermediateToken,
            buyRouter: legacy.buyRouter,
            sellRouter: legacy.sellRouter,
            minIntermediateOut: legacy.minIntermediateOut,
            minFinalOut: legacy.minFinalOut,
            buyFee: 0,
            sellFee: 0,
            gasReserveInAsset: legacy.gasReserveInAsset,
            minProfit: legacy.minProfit,
            deadline: legacy.deadline
        });
        _start(asset, amount, route);
    }

    // New selector is used only when at least one leg is a V3 route.
    function startV3(address asset, uint256 amount, Route calldata route) external onlyOwner whenIdle {
        _start(asset, amount, route);
    }

    // V4 selector carries each pool's exact fee and tick spacing. Hooks are never accepted.
    function startV4(address asset, uint256 amount, RouteV4 calldata route) external onlyOwner whenIdle {
        require(asset == wrappedNative && approvedToken[asset], "ASSET_NOT_ALLOWED");
        require(approvedToken[route.intermediateToken] && route.intermediateToken != asset, "MID_NOT_ALLOWED");
        require(amount > 0 && route.minIntermediateOut > 0 && route.minFinalOut > 0, "BAD_AMOUNT_OR_MIN_OUT");
        require(route.gasReserveInAsset > 0 && route.minProfit > 0, "BAD_PROFIT_GUARD");
        require(route.deadline >= block.timestamp && route.deadline <= block.timestamp + 120, "BAD_DEADLINE");
        if (routerType[route.buyRouter] == 3) _validateV4Leg(route.buyRouter, route.buyFee, route.buyTickSpacing);
        if (routerType[route.sellRouter] == 3) _validateV4Leg(route.sellRouter, route.sellFee, route.sellTickSpacing);
        require(approvedRouter[route.buyRouter] && approvedRouter[route.sellRouter], "ROUTER_NOT_ALLOWED");

        loanAsset = asset;
        loanAmount = amount;
        startingBalance = IERC20(asset).balanceOf(address(this));
        active = true;
        callbackSeen = false;
        v4RouteActive = true;
        pool.flashLoanSimple(address(this), asset, amount, abi.encode(route), 0);
        require(callbackSeen, "NO_CALLBACK");
        require(IERC20(asset).balanceOf(address(this)) >= startingBalance + route.gasReserveInAsset + route.minProfit, "POST_REPAYMENT_PROFIT_CHECK");
        require(IERC20(asset).allowance(address(this), address(pool)) == 0, "POOL_ALLOWANCE_NOT_CLEARED");
        active = false;
        v4RouteActive = false;
        loanAsset = address(0);
        loanAmount = 0;
        startingBalance = 0;
    }

    function _start(address asset, uint256 amount, Route memory route) internal {
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

        if (multiRouteActive) {
            RouteMulti memory r = abi.decode(params, (RouteMulti));
            require(approvedToken[asset] && approvedToken[r.intermediateToken], "TOKEN_REVOKED");
            require(approvedRouter[r.buyRouter] && approvedRouter[r.sellRouter], "ROUTER_REVOKED");
            require(r.deadline >= block.timestamp && r.deadline <= block.timestamp + 120, "ROUTE_EXPIRED");
            _validateMultiLeg(r.buyRouter, asset, r.intermediateToken, r.buyFee, r.buyTickSpacing, r.buyStable);
            _validateMultiLeg(r.sellRouter, r.intermediateToken, asset, r.sellFee, r.sellTickSpacing, r.sellStable);
            uint256 midOut = _swapMulti(r.buyRouter, asset, r.intermediateToken, amount, r.minIntermediateOut, r.deadline, r.buyFee, r.buyTickSpacing, r.buyStable);
            _swapMulti(r.sellRouter, r.intermediateToken, asset, midOut, r.minFinalOut, r.deadline, r.sellFee, r.sellTickSpacing, r.sellStable);
            _finalizeFlashLoan(asset, r.intermediateToken, amount, premium, r.gasReserveInAsset, r.minProfit);
        } else if (v4RouteActive) {
            RouteV4 memory r = abi.decode(params, (RouteV4));
            require(approvedToken[asset] && approvedToken[r.intermediateToken], "TOKEN_REVOKED");
            require(approvedRouter[r.buyRouter] && approvedRouter[r.sellRouter], "ROUTER_REVOKED");
            require(r.deadline >= block.timestamp && r.deadline <= block.timestamp + 120, "ROUTE_EXPIRED");
            if (routerType[r.buyRouter] == 3) _validateV4Leg(r.buyRouter, r.buyFee, r.buyTickSpacing);
            if (routerType[r.sellRouter] == 3) _validateV4Leg(r.sellRouter, r.sellFee, r.sellTickSpacing);
            uint256 midOut = _swapAny(r.buyRouter, asset, r.intermediateToken, amount, r.minIntermediateOut, r.deadline, r.buyFee, r.buyTickSpacing);
            _swapAny(r.sellRouter, r.intermediateToken, asset, midOut, r.minFinalOut, r.deadline, r.sellFee, r.sellTickSpacing);
            _finalizeFlashLoan(asset, r.intermediateToken, amount, premium, r.gasReserveInAsset, r.minProfit);
        } else {
            Route memory r = abi.decode(params, (Route));
            require(approvedToken[asset] && approvedToken[r.intermediateToken], "TOKEN_REVOKED");
            require(approvedRouter[r.buyRouter] && approvedRouter[r.sellRouter], "ROUTER_REVOKED");
            require(r.deadline >= block.timestamp && r.deadline <= block.timestamp + 120, "ROUTE_EXPIRED");
            uint256 midOut = _swap(r.buyRouter, asset, r.intermediateToken, amount, r.minIntermediateOut, r.deadline, r.buyFee);
            _swap(r.sellRouter, r.intermediateToken, asset, midOut, r.minFinalOut, r.deadline, r.sellFee);
            _finalizeFlashLoan(asset, r.intermediateToken, amount, premium, r.gasReserveInAsset, r.minProfit);
        }
        return true;
    }

    function _finalizeFlashLoan(
        address asset, address intermediate, uint256 amount, uint256 premium,
        uint256 gasReserve, uint256 minProfit
    ) internal {
        uint256 owed = amount + premium;
        uint256 requiredBalance = startingBalance + owed + gasReserve + minProfit;
        uint256 finalBalance = IERC20(asset).balanceOf(address(this));
        require(finalBalance >= requiredBalance, "NOT_PROFITABLE");
        _safeApprove(asset, address(pool), owed);
        emit ArbitrageCompleted(asset, intermediate, amount, premium, finalBalance - startingBalance - owed);
    }

    function _validateV4Leg(address manager, uint24 fee, int24 tickSpacing) internal view {
        require(manager == address(poolManager) && routerType[manager] == 3, "BAD_V4_MANAGER");
        require(
            (fee == 500 && tickSpacing == 10) ||
            (fee == 3000 && tickSpacing == 60) ||
            (fee == 10000 && tickSpacing == 200),
            "UNSUPPORTED_V4_POOL_KEY"
        );
    }

    function _validateMultiLeg(
        address router, address tokenIn, address tokenOut,
        uint24 fee, int24 tickSpacing, bool stable
    ) internal view {
        uint8 kind = routerType[router];
        require(approvedRouter[router] && router.code.length > 0, "BAD_ROUTER");
        if (kind == 1) {
            address factory = IV2Router(router).factory();
            require(factory != address(0) && factory == routerFactory[router] && factory.code.length > 0, "V2_FACTORY_MISMATCH");
        } else if (kind == 2) {
            require(fee == 500 || fee == 3000 || fee == 10000, "UNSUPPORTED_V3_FEE");
            address poolAddress = IV3Factory(routerFactory[router]).getPool(tokenIn, tokenOut, fee);
            require(poolAddress != address(0) && poolAddress.code.length > 0, "V3_POOL_MISSING");
        } else if (kind == 3) {
            _validateV4Leg(router, fee, tickSpacing);
        } else if (kind == 4) {
            address factory = routerFactory[router];
            require(factory != address(0) && factory.code.length > 0, "AERODROME_FACTORY_MISSING");
            address poolAddress = IAerodromeFactory(factory).getPool(tokenIn, tokenOut, stable);
            require(poolAddress != address(0) && poolAddress.code.length > 0, "AERODROME_POOL_MISSING");
        } else if (kind == 5) {
            require(
                tickSpacing == 1 || tickSpacing == 50 || tickSpacing == 100 ||
                tickSpacing == 200 || tickSpacing == 2000,
                "UNSUPPORTED_SLIPSTREAM_TICK_SPACING"
            );
            address factory = routerFactory[router];
            require(factory != address(0) && factory.code.length > 0, "SLIPSTREAM_FACTORY_MISSING");
            address poolAddress = ISlipstreamFactory(factory).getPool(tokenIn, tokenOut, tickSpacing);
            require(poolAddress != address(0) && poolAddress.code.length > 0, "SLIPSTREAM_POOL_MISSING");
        } else {
            revert("UNKNOWN_ROUTER_TYPE");
        }
    }

    function _swapMulti(
        address router, address tokenIn, address tokenOut, uint256 amountIn,
        uint256 minOut, uint256 deadline, uint24 fee, int24 tickSpacing, bool stable
    ) internal returns (uint256) {
        uint8 kind = routerType[router];
        if (kind == 3) return _swapV4(tokenIn, tokenOut, amountIn, minOut, fee, tickSpacing);
        SwapRequest memory request = SwapRequest(tokenIn, tokenOut, amountIn, minOut, deadline);
        if (kind == 4) return _swapAerodrome(router, request, stable);
        if (kind == 5) return _swapSlipstream(router, request, tickSpacing);
        return _swap(router, tokenIn, tokenOut, amountIn, minOut, deadline, fee);
    }

    function _swapAerodrome(address router, SwapRequest memory p, bool stable)
        internal returns (uint256 actualAmountOut)
    {
        address factory = routerFactory[router];
        require(approvedRouter[router] && factory != address(0) &&
            IAerodromeRouter(router).defaultFactory() == factory, "AERODROME_ROUTER_FACTORY_MISMATCH");
        require(IAerodromeFactory(factory).getPool(p.tokenIn, p.tokenOut, stable) != address(0), "AERODROME_POOL_MISSING");
        uint256 beforeIn = IERC20(p.tokenIn).balanceOf(address(this));
        uint256 beforeOut = IERC20(p.tokenOut).balanceOf(address(this));
        _safeApprove(p.tokenIn, router, p.amountIn);
        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route(p.tokenIn, p.tokenOut, stable, factory);
        uint256[] memory amounts = IAerodromeRouter(router).swapExactTokensForTokens(
            p.amountIn, p.minOut, routes, address(this), p.deadline
        );
        require(amounts.length == 2 && amounts[1] >= p.minOut, "BAD_AERODROME_SWAP_RESULT");
        uint256 afterIn = IERC20(p.tokenIn).balanceOf(address(this));
        uint256 afterOut = IERC20(p.tokenOut).balanceOf(address(this));
        require(beforeIn >= afterIn && beforeIn - afterIn == p.amountIn, "AERODROME_INPUT_DELTA");
        require(afterOut >= beforeOut, "AERODROME_OUTPUT_DELTA");
        actualAmountOut = afterOut - beforeOut;
        require(actualAmountOut >= p.minOut, "AERODROME_MIN_OUT");
        _safeApprove(p.tokenIn, router, 0);
    }

    function _swapSlipstream(address router, SwapRequest memory p, int24 tickSpacing)
        internal returns (uint256 actualAmountOut)
    {
        address factory = routerFactory[router];
        require(approvedRouter[router] && factory != address(0) &&
            ISlipstreamRouter(router).factory() == factory, "SLIPSTREAM_ROUTER_FACTORY_MISMATCH");
        require(ISlipstreamFactory(factory).getPool(p.tokenIn, p.tokenOut, tickSpacing) != address(0), "SLIPSTREAM_POOL_MISSING");
        uint256 beforeIn = IERC20(p.tokenIn).balanceOf(address(this));
        uint256 beforeOut = IERC20(p.tokenOut).balanceOf(address(this));
        _safeApprove(p.tokenIn, router, p.amountIn);
        uint256 reportedOut = ISlipstreamRouter(router).exactInputSingle(
            ISlipstreamRouter.ExactInputSingleParams({
                tokenIn: p.tokenIn, tokenOut: p.tokenOut, tickSpacing: tickSpacing,
                recipient: address(this), deadline: p.deadline, amountIn: p.amountIn,
                amountOutMinimum: p.minOut, sqrtPriceLimitX96: 0
            })
        );
        uint256 afterIn = IERC20(p.tokenIn).balanceOf(address(this));
        uint256 afterOut = IERC20(p.tokenOut).balanceOf(address(this));
        require(beforeIn >= afterIn && beforeIn - afterIn == p.amountIn, "SLIPSTREAM_INPUT_DELTA");
        require(afterOut >= beforeOut, "SLIPSTREAM_OUTPUT_DELTA");
        actualAmountOut = afterOut - beforeOut;
        require(reportedOut == actualAmountOut && actualAmountOut >= p.minOut, "SLIPSTREAM_OUTPUT_MISMATCH");
        _safeApprove(p.tokenIn, router, 0);
    }

    function _swapAny(
        address router, address tokenIn, address tokenOut, uint256 amountIn,
        uint256 minOut, uint256 deadline, uint24 fee, int24 tickSpacing
    ) internal returns (uint256) {
        if (routerType[router] == 3) {
            return _swapV4(tokenIn, tokenOut, amountIn, minOut, fee, tickSpacing);
        }
        return _swap(router, tokenIn, tokenOut, amountIn, minOut, deadline, fee);
    }

    function _swapV4(
        address tokenIn, address tokenOut, uint256 amountIn,
        uint256 minOut, uint24 fee, int24 tickSpacing
    ) internal returns (uint256 amountOut) {
        require(tokenIn != tokenOut && amountIn > 0 && amountIn <= uint256(uint128(type(int128).max)), "BAD_V4_SWAP");
        _validateV4Leg(address(poolManager), fee, tickSpacing);
        uint256 beforeIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 beforeOut = IERC20(tokenOut).balanceOf(address(this));
        v4UnlockActive = true;
        v4CallbackSeen = false;
        bytes memory result = poolManager.unlock(abi.encode(V4SwapData(tokenIn, tokenOut, amountIn, minOut, fee, tickSpacing)));
        require(v4CallbackSeen, "V4_CALLBACK_MISSING");
        v4UnlockActive = false;
        amountOut = abi.decode(result, (uint256));
        uint256 afterIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 afterOut = IERC20(tokenOut).balanceOf(address(this));
        require(beforeIn >= afterIn && beforeIn - afterIn == amountIn, "V4_INPUT_DELTA_MISMATCH");
        require(afterOut >= beforeOut && afterOut - beforeOut == amountOut && amountOut >= minOut, "V4_OUTPUT_DELTA_MISMATCH");
    }

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
