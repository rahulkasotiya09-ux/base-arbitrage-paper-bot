import "dotenv/config";
import solc from "solc";
import { createPublicClient, getAddress, http, parseGwei } from "viem";
import { base } from "viem/chains";
import { readFile } from "node:fs/promises";

// READ-ONLY: no private key, signing, wallet client, or transaction broadcast.
const wallet = getAddress("0x88073Ad37F9e1cb6E09048c57fAe4A70383D9aBb");
const provider = getAddress(process.env.AAVE_POOL_ADDRESSES_PROVIDER || "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D");
const expectedPool = getAddress(process.env.AAVE_POOL_EXPECTED || "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
const rpc = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const client = createPublicClient({ chain: base, transport: http(rpc) });

const chainId = await client.getChainId();
if (chainId !== 8453) throw new Error(`Wrong chain: expected Base 8453, got ${chainId}`);
const [balance, providerCode, pool] = await Promise.all([
  client.getBalance({ address: wallet }),
  client.getCode({ address: provider }),
  client.readContract({
    address: provider,
    abi: [{ type: "function", name: "getPool", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
    functionName: "getPool"
  })
]);
if (!providerCode || providerCode === "0x") throw new Error("Aave provider has no code");
if (getAddress(pool) !== expectedPool) throw new Error("Aave Pool address mismatch");

// Verify the live Chainlink ETH/USD proxy and its freshness.
const feed = getAddress("0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70");
const feedAbi = [
  { type: "function", name: "description", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [
    { type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }
  ] }
];
const [feedCode, feedDescription, feedDecimals, round] = await Promise.all([
  client.getCode({ address: feed }),
  client.readContract({ address: feed, abi: feedAbi, functionName: "description" }),
  client.readContract({ address: feed, abi: feedAbi, functionName: "decimals" }),
  client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" })
]);
const [roundId, answer, , updatedAt, answeredInRound] = round;
const now = BigInt(Math.floor(Date.now() / 1000));
if (!feedCode || feedCode === "0x") throw new Error("Chainlink ETH/USD feed has no code");
if (feedDescription.trim().toUpperCase() !== "ETH / USD") throw new Error("Unexpected Chainlink feed description");
if (answer <= 0n || updatedAt === 0n || answeredInRound < roundId || now < updatedAt || now - updatedAt > 1800n) {
  throw new Error("Chainlink ETH/USD feed is stale or invalid");
}
if (feedDecimals !== 8) throw new Error("Unexpected Chainlink ETH/USD decimals");

// Verify configured token code and configured V2 router-to-factory mappings.
const erc20Abi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }];
const routerAbi = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }
];
for (const [symbol, token] of Object.entries(JSON.parse(await readFile("config.json", "utf8")).tokens)) {
  const tokenAddress = getAddress(token.address);
  const code = await client.getCode({ address: tokenAddress });
  if (!code || code === "0x") throw new Error(`Configured token ${symbol} has no code`);
}
const cfg = JSON.parse(await readFile("config.json", "utf8"));
for (const venue of cfg.venues) {
  if (venue.type === "v2") {
    const routerAddress = getAddress(venue.router);
    const expectedFactory = getAddress(venue.factory);
    const [routerCode, factoryAddress] = await Promise.all([
      client.getCode({ address: routerAddress }),
      client.readContract({ address: routerAddress, abi: routerAbi, functionName: "factory" })
    ]);
    if (!routerCode || routerCode === "0x" || getAddress(factoryAddress) !== expectedFactory) {
      throw new Error(`Configured V2 router/factory mismatch: ${venue.name}`);
    }
    const factoryCode = await client.getCode({ address: expectedFactory });
    if (!factoryCode || factoryCode === "0x") throw new Error(`V2 factory has no code: ${venue.name}`);
  } else if (venue.type === "v3") {
    for (const [label, address] of [["quoter", venue.quoter], ["router", venue.router], ["factory", venue.factory]]) {
      const code = await client.getCode({ address: getAddress(address) });
      if (!code || code === "0x") throw new Error(`Configured V3 ${label} has no code: ${venue.name}`);
    }
  }
}
const weth = getAddress(cfg.wrappedNative);
const wethBalanceAtPool = await client.readContract({
  address: weth, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(pool)]
});
const premium = await client.readContract({
  address: getAddress(pool),
  abi: [{ type: "function", name: "FLASHLOAN_PREMIUM_TOTAL", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] }],
  functionName: "FLASHLOAN_PREMIUM_TOTAL"
});

const source = await readFile("src/AaveV3FlashArb.sol", "utf8");
const input = {
  language: "Solidity",
  sources: { "AaveV3FlashArb.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["evm.bytecode.object"] } }
  }
};
const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (compiled.errors || []).filter(e => e.severity === "error");
if (errors.length) throw new Error("Solidity compile failed: " + errors.map(e => e.formattedMessage).join("\n"));
const artifact = compiled.contracts["AaveV3FlashArb.sol"].AaveV3FlashArb;
const creationBytecode = "0x" + artifact.evm.bytecode.object;
if (creationBytecode === "0x") throw new Error("Empty creation bytecode");

// Direct EOA deployment would set owner to the user's existing EOA.
const constructorArgs = `0x${provider.slice(2).padStart(64, "0")}${wallet.slice(2).padStart(64, "0")}`;
const initCode = `0x${creationBytecode.slice(2)}${constructorArgs.slice(2)}`;
const [gasEstimate, feeData] = await Promise.all([
  client.estimateGas({ account: wallet, data: initCode }),
  client.estimateFeesPerGas()
]);
const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
if (!maxFeePerGas) throw new Error("RPC returned no usable gas price");
const bufferedGas = gasEstimate * 120n / 100n;
const maxCost = bufferedGas * maxFeePerGas;
const affordable = balance >= maxCost;
const predictedAfter = balance >= maxCost ? balance - maxCost : 0n;

console.log(JSON.stringify({
  mode: "READ-ONLY ESTIMATE — NO SIGNING OR BROADCAST",
  network: "Base Mainnet",
  chainId,
  wallet,
  walletBalanceWei: balance.toString(),
  walletBalanceEth: (Number(balance) / 1e18).toFixed(10),
  aaveProvider: provider,
  verifiedAavePool: getAddress(pool),
  aaveFlashLoanPremiumBps: premium.toString(),
  aaveWethLiquidityWei: wethBalanceAtPool.toString(),
  chainlinkEthUsdFeed: feed,
  chainlinkEthUsdDescription: feedDescription,
  chainlinkEthUsdDecimals: feedDecimals,
  chainlinkEthUsdAnswer: answer.toString(),
  chainlinkEthUsdUpdatedAt: updatedAt.toString(),
  configuredTokensAndDexRouterFactoryMappings: "verified on Base Mainnet",
  constructorOwner: wallet,
  compiler: solc.version(),
  optimizer: { enabled: true, runs: 200 },
  creationBytecodeBytes: (creationBytecode.length - 2) / 2,
  estimatedDeploymentGas: gasEstimate.toString(),
  gasWith20PercentBuffer: bufferedGas.toString(),
  maxFeePerGasWei: maxFeePerGas.toString(),
  maxDeploymentCostWei: maxCost.toString(),
  maxDeploymentCostEth: (Number(maxCost) / 1e18).toFixed(10),
  balanceCoversBufferedEstimate: affordable,
  estimatedRemainingWei: affordable ? predictedAfter.toString() : null,
  warning: "This estimates direct EOA deployment only. Actual inclusion cost can differ. Deployment is NOT recommended until contract security/profit accounting is fixed. This script does not sign or send."
}, null, 2));
