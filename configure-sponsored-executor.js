import "dotenv/config";
import {
  createPublicClient, encodeFunctionData, getAddress, http, isAddress, parseAbi
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createSmartAccountClient } from "permissionless";
import { toSimpleSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";

for (const key of ["BASE_SEPOLIA_RPC_URL", "PIMLICO_API_KEY", "WALLET_PRIVATE_KEY", "EXECUTOR_ADDRESS", "ALLOWED_TOKENS", "ALLOWED_ROUTERS"]) {
  if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.WALLET_PRIVATE_KEY)) {
  throw new Error("WALLET_PRIVATE_KEY must be a 32-byte hex key");
}
function addresses(name) {
  const values = process.env[name].split(",").map(x => x.trim()).filter(Boolean);
  if (values.length === 0 || values.some(x => !isAddress(x))) throw new Error(`${name} must be a comma-separated list of valid addresses`);
  return [...new Set(values.map(value => getAddress(value)))];
}

const owner = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY);
const executor = getAddress(process.env.EXECUTOR_ADDRESS);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL) });
const chainId = await publicClient.getChainId();
if (chainId !== baseSepolia.id) throw new Error(`RPC chain mismatch: expected Base Sepolia ${baseSepolia.id}, received ${chainId}`);
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
const smartClient = createSmartAccountClient({
  account,
  chain: baseSepolia,
  bundlerTransport: http(pimlicoUrl),
  paymaster: pimlicoClient,
  userOperation: { estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast }
});
const abi = parseAbi([
  "function owner() view returns (address)",
  "function setToken(address token,bool approved)",
  "function setRouter(address router,bool approved)"
]);
const contractOwner = await publicClient.readContract({ address: executor, abi, functionName: "owner" });
if (contractOwner.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error(`Executor owner mismatch: contract=${contractOwner}, smartAccount=${account.address}`);
}
const calls = [
  ...addresses("ALLOWED_TOKENS").map(token => ({
    to: executor, value: 0n,
    data: encodeFunctionData({ abi, functionName: "setToken", args: [token, true] })
  })),
  ...addresses("ALLOWED_ROUTERS").map(router => ({
    to: executor, value: 0n,
    data: encodeFunctionData({ abi, functionName: "setRouter", args: [router, true] })
  }))
];
for (const call of calls) {
  await publicClient.call({ account: account.address, to: call.to, data: call.data });
}
console.log(JSON.stringify({
  network: baseSepolia.name,
  smartAccount: account.address,
  executor,
  tokensToAllow: addresses("ALLOWED_TOKENS"),
  routersToAllow: addresses("ALLOWED_ROUTERS"),
  mode: process.env.SPONSORED_CONFIGURE === "true" ? "SPONSORED CONFIGURATION ENABLED" : "SIMULATION ONLY"
}, null, 2));
if (process.env.SPONSORED_CONFIGURE !== "true") {
  console.log("No configuration sent. Set SPONSORED_CONFIGURE=true only after verifying every token and router address.");
  process.exit(0);
}
const hash = await smartClient.sendUserOperation({ calls });
console.log("Sponsored configuration UserOperation:", hash);
const receipt = await smartClient.waitForUserOperationReceipt({ hash });
if (!receipt.success) throw new Error(`Configuration UserOperation failed: ${receipt.reason ?? "unknown reason"}`);
console.log(JSON.stringify({
  transactionHash: receipt.receipt.transactionHash,
  actualGasCostWei: receipt.actualGasCost.toString(),
  sponsorPaidGas: true
}, null, 2));
