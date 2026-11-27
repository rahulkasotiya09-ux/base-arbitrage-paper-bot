// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AaveV3FlashArb.sol";

/// @notice Focused callback-authentication and access-control regression tests.
/// @dev Run against a Base fork with BASE_RPC_URL configured.
contract AaveV3CallbackSecurityTest is Test {
    address constant ADDRESSES_PROVIDER = 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant UNISWAP_V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address constant BASESWAP_V2_ROUTER = 0x327Df1E6de05895d2ab08513aaDD9313Fe505d86;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
    }

    function testRejectsCallbackFromNonPool() public {
        AaveV3FlashArb receiver = new AaveV3FlashArb(ADDRESSES_PROVIDER, address(this), WETH);
        vm.expectRevert(bytes("ONLY_POOL"));
        receiver.executeOperation(WETH, 1, 0, address(receiver), bytes(""));
    }

    function testRejectsCallbackFromPoolWhileIdle() public {
        AaveV3FlashArb receiver = new AaveV3FlashArb(ADDRESSES_PROVIDER, address(this), WETH);
        vm.prank(address(receiver.pool()));
        vm.expectRevert(bytes("UNEXPECTED_CALLBACK"));
        receiver.executeOperation(WETH, 1, 0, address(receiver), bytes(""));
    }

    function testRejectsWrongInitiatorFromPoolWhileIdle() public {
        AaveV3FlashArb receiver = new AaveV3FlashArb(ADDRESSES_PROVIDER, address(this), WETH);
        vm.prank(address(receiver.pool()));
        vm.expectRevert(bytes("BAD_INITIATOR"));
        receiver.executeOperation(WETH, 1, 0, address(0xBEEF), bytes(""));
    }

    function testOnlyOwnerCanStart() public {
        AaveV3FlashArb receiver = new AaveV3FlashArb(ADDRESSES_PROVIDER, address(this), WETH);
        AaveV3FlashArb.Route memory route = AaveV3FlashArb.Route({
            intermediateToken: USDC,
            buyRouter: UNISWAP_V2_ROUTER,
            sellRouter: BASESWAP_V2_ROUTER,
            minIntermediateOut: 1,
            minFinalOut: 1,
            gasReserveInAsset: 1,
            minProfit: 1,
            deadline: block.timestamp + 60
        });
        vm.prank(address(0xBEEF));
        vm.expectRevert(bytes("NOT_OWNER"));
        receiver.start(WETH, 1, route);
    }
}
