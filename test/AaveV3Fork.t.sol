// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AaveV3FlashArb.sol";

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

    function testOnlyOwnerCanConfigure() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        AaveV3FlashArb receiver = new AaveV3FlashArb(ADDRESSES_PROVIDER);
        vm.prank(address(0xBEEF));
        vm.expectRevert(bytes("NOT_OWNER"));
        receiver.setToken(address(0x1234), true);
    }
}