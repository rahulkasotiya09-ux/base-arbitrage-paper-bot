import "dotenv/config";
import solc from "solc";
import {
  concat, createPublicClient, encodeAbiParameters, formatEther, getAddress,
  getCreate2Address, http, keccak256, privateKeyToAccount, serializeTransaction, toBytes
} from "viem";
import { base } from "viem/chains";
import { readFile } from "node:fs/promises";

const rawKey = process.env.WALLET_PRIVATE_KEY?.trim();
if (!rawKey) throw new Error("Missing WALLET_PRIVATE_KEY GitHub Actions secret.");
const privateKey = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("WALLET_PRIVATE_KEY must be 64 hex characters, optionally prefixed with 0x.");

const rpc = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const provider = getAddress(process.env.AAVE_POOL_ADDRESSES_PROVIDER || "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D");
const expectedPool = getAddress(process.env.AAVE_POOL_EXPECTED || "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
const create2Factory = getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C");
const gasOracle = getAddress("0x420000000000000000000000000000000000000F");
const client = createPublicClient({ chain: base, transport: http(rpc) });

if (await client.getChainId() !== 8453) throw new Error("RPC is not Base Mainnet (chain ID 8453).");
const owner = privateKeyToAccount(privateKey);
const [balance, factoryCode, providerPool] = await Promise.all([
  client.getBalance({ address: owner.address }),
  client.getCode({ address: create2Factory }),
  client.readContract({
    address: provider,
    abi: [{ type: "function", name: "getPool", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
    functionName: "getPool"
  })
]);
if (!factoryCode || factoryCode === "0x") throw new Error("Canonical CREATE2 deployer code is missing on Base.");
if (getAddress(providerPool) !== expectedPool) throw new Error("Aave Pool address mismatch; estimate aborted.");

const source = await readFile("src/AaveV3FlashArb.sol", "utf8");
const input = {
  language: "Solidity",
  sources: { "AaveV3FlashArb.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["evm.bytecode.object", "abi"] } }
  }
};
const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (compiled.errors || []).filter(e => e.severity === "error");
if (errors.length) throw new Error("Solidity compilation failed: " + errors.map(e => e.formattedMessage).join("\n"));
const artifact = compiled.contracts["AaveV3FlashArb.sol"].AaveV3FlashArb;
const creationBytecode = "0x" + artifact.evm.bytecode.object;
if (creationBytecode === "0x") throw new Error("Compiler returned empty creation bytecode.");

// This estimate assumes the existing EOA is the contract owner and will pay deployment gas.
const constructorArgs = encodeAbiParameters(
  [{ type: "address" }, { type: "address" }],
  [provider, owner.address]
);
const initCode = concat([creationBytecode, constructorArgs]);
const salt = keccak256(toBytes("base-arbitrage-paper-bot:AaveV3FlashArb:v1"));
const predictedAddress = getCreate2Address({
  from: create2Factory, salt, bytecodeHash: keccak256(initCode)
});
const existingCode = await client.getCode({ address: predictedAddress });
if (existingCode && existingCode !== "0x") throw new Error("Predicted contract address already has code; no deployment estimate needed.");

const factoryCallData = concat([salt, initCode]);
const gasEstimate = await client.estimateGas({
  account: owner.address,
  to: create2Factory,
  value: 0n,
  data: factoryCallData
});
const fees = await client.estimateFeesPerGas();
if (fees.maxFeePerGas == null || fees.maxPriorityFeePerGas == null) {
  throw new Error("RPC did not return EIP-1559 fee estimates; refusing to report an incomplete total.");
}
const nonce = await client.getTransactionCount({ address: owner.address });
const unsignedTx = serializeTransaction({
  type: "eip1559",
  chainId: 8453,
  nonce,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  maxFeePerGas: fees.maxFeePerGas,
  gas: gasEstimate,
  to: create2Factory,
  value: 0n,
  data: factoryCallData
});
const l1DataFee = await client.readContract({
  address: gasOracle,
  abi: [{
    type: "function", name: "getL1Fee", stateMutability: "view",
    inputs: [{ name: "_data", type: "bytes" }], outputs: [{ name: "", type: "uint256" }]
  }],
  functionName: "getL1Fee",
  args: [unsignedTx]
});
const executionFeeUpper = gasEstimate * fees.maxFeePerGas;
const totalFeeUpper = executionFeeUpper + l1DataFee;
const bufferedRequired = (totalFeeUpper * 125n) / 100n;

console.log(JSON.stringify({
  mode: "READ-ONLY DEPLOYMENT ESTIMATE — NO SIGNATURE, NO TRANSACTION",
  network: "Base Mainnet",
  chainId: 8453,
  wallet: owner.address,
  walletBalanceWei: balance.toString(),
  walletBalanceETH: formatEther(balance),
  contract: "AaveV3FlashArb",
  compiler: solc.version(),
  optimizer: { enabled: true, runs: 200 },
  contractOwner: owner.address,
  predictedContractAddress: predictedAddress,
  creationBytecodeBytes: (creationBytecode.length - 2) / 2,
  create2Factory,
  estimatedGasLimit: gasEstimate.toString(),
  maxFeePerGasWei: fees.maxFeePerGas.toString(),
  executionFeeUpperBoundWei: executionFeeUpper.toString(),
  executionFeeUpperBoundETH: formatEther(executionFeeUpper),
  l1DataFeeWei: l1DataFee.toString(),
  l1DataFeeETH: formatEther(l1DataFee),
  totalFeeUpperBoundWei: totalFeeUpper.toString(),
  totalFeeUpperBoundETH: formatEther(totalFeeUpper),
  requiredWith25PercentBufferETH: formatEther(bufferedRequired),
  balanceCoversBufferedEstimate: balance >= bufferedRequired,
  note: "Estimate only. Includes EIP-1559 execution maximum and Base L1 data fee for the unsigned serialized transaction, plus a 25% reserve. It does not sign, submit, deploy, or guarantee the eventual transaction fee."
}, null, 2));
