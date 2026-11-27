import { createPublicClient, formatUnits, getAddress, http, parseAbi } from "viem";
import { base } from "viem/chains";

// Read-only mainnet check. This script never signs or broadcasts a transaction.
const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const EXPECTED_PROVIDER = getAddress("0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D");
const EXPECTED_POOL = getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
const DATA_PROVIDER = getAddress("0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A");

const client = createPublicClient({ chain: base, transport: http(RPC_URL) });
const providerAbi = parseAbi(["function getPool() view returns (address)"]);
const poolAbi = parseAbi([
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
  "function getConfiguration(address asset) view returns ((uint256 data) configuration)"
]);
const dataProviderAbi = parseAbi([
  "function getAllReservesTokens() view returns ((string symbol,address tokenAddress)[] tokens)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)"
]);
const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
]);

const chainId = await client.getChainId();
if (chainId !== base.id) throw new Error(`Wrong chain: expected Base ${base.id}, got ${chainId}`);

const livePool = getAddress(await client.readContract({
  address: EXPECTED_PROVIDER, abi: providerAbi, functionName: "getPool"
}));
if (livePool !== EXPECTED_POOL) {
  throw new Error(`Aave pool address mismatch. Expected ${EXPECTED_POOL}, provider returned ${livePool}`);
}
const premiumBps = await client.readContract({
  address: livePool, abi: poolAbi, functionName: "FLASHLOAN_PREMIUM_TOTAL"
});
const reserves = await client.readContract({
  address: DATA_PROVIDER, abi: dataProviderAbi, functionName: "getAllReservesTokens"
});

const results = [];
for (const reserve of reserves) {
  const asset = getAddress(reserve.tokenAddress);
  const [config, reserveConfig, liquidityRaw, symbol, decimals] = await Promise.all([
    client.readContract({ address: livePool, abi: poolAbi, functionName: "getConfiguration", args: [asset] }),
    client.readContract({ address: DATA_PROVIDER, abi: dataProviderAbi, functionName: "getReserveConfigurationData", args: [asset] }),
    client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [livePool] }),
    client.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" })
  ]);
  const flashLoanEnabled = ((config.data >> 63n) & 1n) === 1n;
  const active = reserveConfig[8];
  const frozen = reserveConfig[9];
  results.push({
    symbol,
    token: asset,
    decimals: Number(decimals),
    active,
    frozen,
    flashLoanEnabled,
    availableLiquidityRaw: liquidityRaw.toString(),
    availableLiquidity: formatUnits(liquidityRaw, decimals)
  });
}
const eligible = results.filter(x => x.active && !x.frozen && x.flashLoanEnabled && BigInt(x.availableLiquidityRaw) > 0n);
console.log(JSON.stringify({
  mode: "READ-ONLY PREFLIGHT — NO TRANSACTIONS SENT",
  network: base.name,
  chainId,
  provider: EXPECTED_PROVIDER,
  pool: livePool,
  flashLoanPremiumBasisPoints: premiumBps.toString(),
  reservesChecked: results.length,
  flashLoanCandidates: eligible,
  allReserves: results
}, null, 2));
