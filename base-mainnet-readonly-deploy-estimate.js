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
