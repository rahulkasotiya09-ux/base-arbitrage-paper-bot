// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/AaveV3FlashArb.sol";

/// @notice Explicit, Base-mainnet-only deployment and initial allowlist setup.
/// @dev Broadcast only through the separately gated GitHub deployment workflow.
contract DeployBase is Script {
    address internal constant AAVE_PROVIDER = 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D;
    address internal constant EXPECTED_AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant CBETH = 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22;
    address internal constant WEETH = 0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A;
    address internal constant WSTETH = 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452;
    address internal constant GHO = 0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee;

    // Only V2 routers are supported by AaveV3FlashArb's swap interface.
    address internal constant UNISWAP_V2_ROUTER = 0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24;
    address internal constant BASESWAP_V2_ROUTER = 0x327Df1E6de05895d2ab08513aaDD9313Fe505d86;

    event ExecutorDeployed(address indexed executor, address indexed owner, bytes32 runtimeCodeHash);

    function run() external {
        require(block.chainid == 8453, "BASE_MAINNET_ONLY");
        uint256 privateKey = vm.envUint("WALLET_PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        require(deployer == 0x88073Ad37F9e1cb6E09048c57fAe4A70383D9aBb, "UNEXPECTED_DEPLOYER");

        address livePool = IPoolAddressesProvider(AAVE_PROVIDER).getPool();
        require(livePool == EXPECTED_AAVE_POOL, "AAVE_POOL_MISMATCH");

        vm.startBroadcast(privateKey);
        AaveV3FlashArb executor = new AaveV3FlashArb(AAVE_PROVIDER, deployer, WETH);

        executor.setToken(WETH, true);
        executor.setToken(USDC, true);
        executor.setToken(CBETH, true);
        executor.setToken(WEETH, true);
        executor.setToken(WSTETH, true);
        executor.setToken(GHO, true);

        executor.setRouter(UNISWAP_V2_ROUTER, true);
        executor.setRouter(BASESWAP_V2_ROUTER, true);
        vm.stopBroadcast();

        require(address(executor).code.length > 0, "DEPLOYED_CODE_MISSING");
        require(executor.owner() == deployer, "OWNER_MISMATCH");
        require(address(executor.pool()) == EXPECTED_AAVE_POOL, "DEPLOYED_POOL_MISMATCH");
        emit ExecutorDeployed(address(executor), deployer, address(executor).codehash);
    }
}
