import "dotenv/config";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  isAddress,
  getAddress
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createSmartAccountClient } from "permissionless";
import { toSimpleSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";

const required = [
  "BASE_SEPOLIA_RPC_URL",
  "PIMLICO_API_KEY",
  "WALLET_PRIVATE_KEY",
  "EXECUTOR_ADDRESS",
  "ASSET_ADDRESS",
  "INTERMEDIATE_TOKEN_ADDRESS",
  "BUY_ROUTER_ADDRESS",
  "SELL_ROUTER_ADDRESS",
  "LOAN_AMOUNT",
  "MIN_INTERMEDIATE_OUT",
  "MIN_FINAL_OUT",
  "MIN_PROFIT_BASE_UNITS"
];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
}

function addressEnv(name) {
  const value = process.env[name];
  if (!isAddress(value)) throw new Error(`${name} is not a valid address`);
  return getAddress(value);
}
function uintEnv(name) {
  const value = process.env[name];
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer in base units`);
  return BigInt(value);
}

const executorAddress = addressEnv("EXECUTOR_ADDRESS");
const asset = addressEnv("ASSET_ADDRESS");
const intermediateToken = addressEnv("INTERMEDIATE_TOKEN_ADDRESS");
const buyRouter = addressEnv("BUY_ROUTER_ADDRESS");
const sellRouter = addressEnv("SELL_ROUTER_ADDRESS");
const amount = uintEnv("LOAN_AMOUNT");
const minIntermediateOut = uintEnv("MIN_INTERMEDIATE_OUT");
const minFinalOut = uintEnv("MIN_FINAL_OUT");
const minProfit = uintEnv("MIN_PROFIT_BASE_UNITS");

if (amount <= 0n || minIntermediateOut <= 0n || minFinalOut <= 0n) {
  throw new Error("Loan amount and minimum outputs must be greater than zero");
}
if (asset === intermediateToken) throw new Error("Borrowed and intermediate assets must differ");

const ownerKey = process.env.WALLET_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(ownerKey)) throw new Error("WALLET_PRIVATE_KEY must be a 32-byte hex key");
const owner = privateKeyToAccount(ownerKey);
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC_URL)
});
const pimlicoUrl = `https://api.pimlico.io/v2/${baseSepolia.id}/rpc?apikey=${process.env.PIMLICO_API_KEY}`;
const pimlicoClient = createPimlicoClient({
  chain: baseSepolia,
  transport: http(pimlicoUrl),
  entryPoint: { address: entryPoint07Address, version: "0.7" }
});
const account = await toSimpleSmartAccount({
  client: publicClient,
  owner,
  entryPoint: { address: entryPoint07Address, version: "0.7" }
});
const smartAccountClient = createSmartAccountClient({
  account,
  chain: baseSepolia,
  bundlerTransport: http(pimlicoUrl),
  paymaster: pimlicoClient,
  userOperation: {
    estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast
  }
});

const abi = parseAbi([
  "function owner() view returns (address)",
  "function start(address asset,uint256 amount,(address intermediateToken,address buyRouter,address sellRouter,uint256 minIntermediateOut,uint256 minFinalOut,uint256 gasCostInAsset,uint256 minProfit,uint256 deadline) route)"
]);
const contractOwner = await publicClient.readContract({
  address: executorAddress,
  abi,
  functionName: "owner"
});
if (contractOwner.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error(`Executor owner mismatch. Contract owner: ${contractOwner}; smart account: ${account.address}. Deploy with ownerAddress set to this smart-account address.`);
}

const route = {
  intermediateToken,
  buyRouter,
  sellRouter,
  minIntermediateOut,
  minFinalOut,
  // The paymaster pays network gas on this testnet operation; no native-gas reserve is passed.
  gasCostInAsset: 0n,
  minProfit,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 60)
};
const data = encodeFunctionData({
  abi,
  functionName: "start",
  args: [asset, amount, route]
});

// eth_call checks the complete Aave callback + two swaps + repayment without broadcasting.
await publicClient.call({
  account: account.address,
  to: executorAddress,
  data
});
console.log(JSON.stringify({
  network: baseSepolia.name,
  chainId: baseSepolia.id,
  mode: process.env.SPONSORED_SEND === "true" ? "TESTNET SPONSORED SEND ENABLED" : "SIMULATION ONLY",
  smartAccount: account.address,
  executor: executorAddress,
  loanAmount: amount.toString(),
  minimumProfit: minProfit.toString(),
  simulated: true
}, null, 2));

if (process.env.SPONSORED_SEND !== "true") {
  console.log("No UserOperation sent. Set SPONSORED_SEND=true only when ready to use Base Sepolia test funds.");
  process.exit(0);
}

const userOpHash = await smartAccountClient.sendUserOperation({
  calls: [{ to: executorAddress, value: 0n, data }]
});
console.log("Sponsored UserOperation submitted:", userOpHash);
const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash: userOpHash });
if (!receipt.success) {
  throw new Error(`Sponsored UserOperation failed: ${receipt.reason ?? "unknown reason"}`);
}
console.log(JSON.stringify({
  transactionHash: receipt.receipt.transactionHash,
  actualGasCostWei: receipt.actualGasCost.toString(),
  sponsorPaidGas: true,
  network: baseSepolia.name
}, null, 2));
