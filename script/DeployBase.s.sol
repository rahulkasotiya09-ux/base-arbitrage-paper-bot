// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/AaveV3FlashArbV4.sol";

/// @notice Base-mainnet deployment and initial allowlist setup for the current V4 executor.
/// @dev This script broadcasts only when explicitly run with --broadcast and a funded,
/// approved deployment key. It does not change the production bot's executor address.
contract DeployBase is Script {
    address internal constant AAVE_PROVIDER = 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D;
    address internal constant EXPECTED_AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant CBETH = 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22;
    address internal constant WEETH = 0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A;
    address internal constant WSTETH = 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452;
    address internal constant GHO = 0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee;
    address internal constant AERO = 0x940181a94A35A4569E4529A3CDfB74e38FD98631;
    address internal constant CBBTC = 0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf;

    address internal constant UNISWAP_V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address internal constant BASESWAP_V2_ROUTER = 0x327Df1E6de05895d2ab08513aaDD9313Fe505d86;
    address internal constant UNISWAP_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant UNISWAP_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;

    address internal constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address internal constant AERODROME_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address internal constant SLIPSTREAM_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address internal constant SLIPSTREAM_FACTORY = 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A;
    address internal constant UNISWAP_V4_POOL_MANAGER = 0x498581ff718922c3f8e6a244956af099b2652b2b;

    event ExecutorDeployed(address indexed executor, address indexed owner, bytes32 runtimeCodeHash);

    function _privateKeyFromEnv() internal view returns (uint256 key) {
        string memory raw = vm.envString("WALLET_PRIVATE_KEY");
        bytes memory data = bytes(raw);
        uint256 offset = data.length == 66 && data[0] == "0" && (data[1] == "x" || data[1] == "X") ? 2 : 0;
        require(data.length - offset == 64, "PRIVATE_KEY_MUST_BE_32_BYTE_HEX");
        for (uint256 i = offset; i < data.length; ++i) {
            uint8 ch = uint8(data[i]);
            uint256 digit;
            if (ch >= 48 && ch <= 57) digit = ch - 48;
            else if (ch >= 65 && ch <= 70) digit = ch - 55;
            else if (ch >= 97 && ch <= 102) digit = ch - 87;
            else revert("PRIVATE_KEY_NOT_HEX");
            key = (key << 4) | digit;
        }
        require(key != 0, "PRIVATE_KEY_ZERO");
    }

    function run() external {
        require(block.chainid == 8453, "BASE_MAINNET_ONLY");
        uint256 privateKey = _privateKeyFromEnv();
        address deployer = vm.addr(privateKey);
        require(deployer == 0x88073Ad37F9e1cb6E09048c57fAe4A70383D9aBb, "UNEXPECTED_DEPLOYER");

        address livePool = IPoolAddressesProvider(AAVE_PROVIDER).getPool();
        require(livePool == EXPECTED_AAVE_POOL, "AAVE_POOL_MISMATCH");

        vm.startBroadcast(privateKey);
        AaveV3FlashArbV4 executor = new AaveV3FlashArbV4(
            AAVE_PROVIDER, deployer, WETH, UNISWAP_V4_POOL_MANAGER
        );

        executor.setToken(WETH, true);
        executor.setToken(USDC, true);
        executor.setToken(CBETH, true);
        executor.setToken(WEETH, true);
        executor.setToken(WSTETH, true);
        executor.setToken(GHO, true);
        executor.setToken(AERO, true);
        executor.setToken(CBBTC, true);

        executor.setRouter(UNISWAP_V2_ROUTER, true);
        executor.setRouter(BASESWAP_V2_ROUTER, true);
        executor.setV3Router(UNISWAP_V3_ROUTER, UNISWAP_V3_FACTORY, true);
        executor.setAerodromeRouter(AERODROME_ROUTER, AERODROME_FACTORY, true);
        executor.setSlipstreamRouter(SLIPSTREAM_ROUTER, SLIPSTREAM_FACTORY, true);
        vm.stopBroadcast();

        require(address(executor).code.length > 0, "DEPLOYED_CODE_MISSING");
        require(executor.owner() == deployer, "OWNER_MISMATCH");
        require(address(executor.pool()) == EXPECTED_AAVE_POOL, "DEPLOYED_POOL_MISMATCH");
        require(address(executor.poolManager()) == UNISWAP_V4_POOL_MANAGER, "POOL_MANAGER_MISMATCH");
        require(executor.approvedRouter(UNISWAP_V2_ROUTER), "UNISWAP_V2_NOT_REGISTERED");
        require(executor.approvedRouter(BASESWAP_V2_ROUTER), "BASESWAP_V2_NOT_REGISTERED");
        require(executor.approvedRouter(UNISWAP_V3_ROUTER), "UNISWAP_V3_NOT_REGISTERED");
        require(executor.approvedRouter(AERODROME_ROUTER), "AERODROME_NOT_REGISTERED");
        require(executor.approvedRouter(SLIPSTREAM_ROUTER), "SLIPSTREAM_NOT_REGISTERED");
        emit ExecutorDeployed(address(executor), deployer, address(executor).codehash);
    }
}
