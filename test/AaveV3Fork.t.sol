// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AaveV3FlashArb.sol";

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniswapV2Pair {
    function sync() external;
}

contract AaveV3ForkTest is Test {
    // Aave V3 Ethereum Mainnet PoolAddressesProvider (official deployment).
    address constant ADDRESSES_PROVIDER = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;

    function testForkResolvesLiveAavePoolAndPremium() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        IPoolAddressesProvider provider = IPoolAddressesProvider(ADDRESSES_PROVIDER);
        address poolAddress = provider.getPool();

        assertTrue(poolAddress.code.length > 0, "Aave Pool proxy missing");
        uint128 premium = IAaveV3Pool(poolAddress).FLASHLOAN_PREMIUM_TOTAL();
        assertGt(uint256(premium), 0, "unexpected zero premium; verify governance setting");
    }

    function testReceiverUsesProviderPool() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        AaveV3FlashArb receiver = new AaveV3FlashArb(ADDRESSES_PROVIDER);
        assertEq(address(receiver.pool()), IPoolAddressesProvider(ADDRESSES_PROVIDER).getPool());
        assertEq(receiver.owner(), address(this));
    }

    function testForkExecutesProfitableFlashLoanTwoSwapsAndRepays() public {
        vm.createSelectFork(vm.envString("RPC_URL"));

        AaveV3FlashArb receiver = new AaveV3FlashArb(ADDRESSES_PROVIDER);
        address sushiRouter = 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F;

        // Locate the real WETH/USDC V2 pairs behind the two real router contracts.
        address uniFactory = IV2Router(UNISWAP_V2_ROUTER).factory();
        address sushiFactory = IV2Router(sushiRouter).factory();
        address uniPair = IUniswapV2Factory(uniFactory).getPair(WETH, USDC);
        address sushiPair = IUniswapV2Factory(sushiFactory).getPair(WETH, USDC);
        assertTrue(uniPair.code.length > 0, "Uniswap WETH/USDC pair missing");
        assertTrue(sushiPair.code.length > 0, "Sushi WETH/USDC pair missing");

        // Deterministically create a profitable price spread on this fork only:
        // buy USDC at 3,000 USDC/WETH on Uniswap, then buy WETH at 2,500 USDC/WETH on Sushi.
        deal(WETH, uniPair, 1_000 ether);
        deal(USDC, uniPair, 3_000_000e6);
        IUniswapV2Pair(uniPair).sync();

        deal(WETH, sushiPair, 1_000 ether);
        deal(USDC, sushiPair, 2_500_000e6);
        IUniswapV2Pair(sushiPair).sync();

        receiver.setToken(WETH, true);
        receiver.setToken(USDC, true);
        receiver.setRouter(UNISWAP_V2_ROUTER, true);
        receiver.setRouter(sushiRouter, true);

        uint256 loanAmount = 1 ether;
        uint256 minUsdcOut = 2_900e6;
        uint256 minWethOut = 1.10 ether;
        AaveV3FlashArb.Route memory route = AaveV3FlashArb.Route({
            intermediateToken: USDC,
            buyRouter: UNISWAP_V2_ROUTER,
            sellRouter: sushiRouter,
            minIntermediateOut: minUsdcOut,
            minFinalOut: minWethOut,
            gasCostInAsset: 0.005 ether,
            minProfit: 0.01 ether,
            deadline: block.timestamp + 60
        });

        uint256 balanceBefore = IERC20(WETH).balanceOf(address(receiver));
        receiver.start(WETH, loanAmount, route);
        uint256 balanceAfter = IERC20(WETH).balanceOf(address(receiver));

        assertGe(balanceAfter, balanceBefore + 0.01 ether, "minimum net profit not retained");
        assertEq(IERC20(WETH).allowance(address(receiver), address(receiver.pool())), 0, "unexpected leftover pool allowance");
    }

    function testForkRejectsLosingFlashLoanRoundTrip() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        AaveV3FlashArb receiver = new AaveV3FlashArb(ADDRESSES_PROVIDER);
        receiver.setToken(WETH, true);
        receiver.setToken(USDC, true);
        receiver.setRouter(UNISWAP_V2_ROUTER, true);

        AaveV3FlashArb.Route memory route = AaveV3FlashArb.Route({
            intermediateToken: USDC,
            buyRouter: UNISWAP_V2_ROUTER,
            sellRouter: UNISWAP_V2_ROUTER,
            minIntermediateOut: 1,
            minFinalOut: 1,
            gasCostInAsset: 0,
            minProfit: 0,
            deadline: block.timestamp + 60
        });

        // A round trip through the same AMM pays trading fees twice and must revert.
        vm.expectRevert(bytes("NOT_PROFITABLE"));
        receiver.start(WETH, 0.01 ether, route);
    }

    function testOnlyOwnerCanConfigure() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        AaveV3FlashArb receiver = new AaveV3FlashArb(ADDRESSES_PROVIDER);
        vm.prank(address(0xBEEF));
        vm.expectRevert(bytes("NOT_OWNER"));
        receiver.setToken(address(0x1234), true);
    }
}