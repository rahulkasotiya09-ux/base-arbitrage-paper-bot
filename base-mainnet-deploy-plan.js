import "dotenv/config";
import solc from "solc";
import {
  concat, createPublicClient, encodeAbiParameters, getAddress, getCreate2Address,
  http, keccak256, toBytes
} from "viem";
import { base } from "viem/chains";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { createSmartAccountClient } from "permissionless";
import { toSimpleSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { readFile } from "node:fs/promises";

const required = ["WALLET_PRIVATE_KEY", "PIMLICO_API_KEY"];
for (const name of required) if (!process.env[name]) throw new Error("Missing required GitHub Actions secret: " + name);
const rawKey = process.env.WALLET_PRIVATE_KEY.trim();
const privateKey = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("WALLET_PRIVATE_KEY must be 64 hex characters, optionally prefixed with 0x.");

const rpc = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const provider = getAddress(process.env.AAVE_POOL_ADDRESSES_PROVIDER || "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D");
const expectedPool = getAddress(process.env.AAVE_POOL_EXPECTED || "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
const create2Factory = getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C");
const client = createPublicClient({ chain: base, transport: http(rpc) });
if (await client.getChainId() !== 8453) throw new Error("RPC is not Base mainnet (8453).");

const [factoryCode, providerPool] = await Promise.all([
  client.getCode({ address: create2Factory }),
  client.readContract({
    address: provider,
    abi: [{ type: "function", name: "getPool", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
    functionName: "getPool"
  })
]);
if (!factoryCode || factoryCode === "0x") throw new Error("Canonical CREATE2 deployer is not present on Base; refusing to prepare deployment.");
if (getAddress(providerPool) !== expectedPool) throw new Error("Aave Pool address mismatch; refusing deployment preparation.");

const owner = privateKeyToAccount(privateKey);
const account = await toSimpleSmartAccount({
  client, owner, entryPoint: { address: entryPoint07Address, version: "0.7" }
});
const smartCode = await client.getCode({ address: account.address });

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
if (existingCode && existingCode !== "0x") throw new Error("Predicted contract address already has code; refusing duplicate deployment.");

const factoryCallData = concat([salt, initCode]);
const pimlicoUrl = `https://api.pimlico.io/v2/${base.id}/rpc?apikey=${process.env.PIMLICO_API_KEY}`;
const pimlico = createPimlicoClient({
  chain: base,
  transport: http(pimlicoUrl),
  entryPoint: { address: entryPoint07Address, version: "0.7" }
});
const smartClient = createSmartAccountClient({
  account,
  chain: base,
  client,
  bundlerTransport: http(pimlicoUrl),
  paymaster: pimlico,
  userOperation: {
    estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast
  }
});

// Preparing estimates and requests paymaster data, but does not sign or submit the UserOperation.
const prepared = await smartClient.prepareUserOperation({
  calls: [{ to: create2Factory, value: 0n, data: factoryCallData }]
});
const paymasterAddress = prepared.paymaster;
const hasPaymaster = typeof paymasterAddress === "string" && paymasterAddress !== "0x";
if (!hasPaymaster) throw new Error("Pimlico did not attach paymaster data; no sponsored deployment is available for this operation.");

const gasFields = ["callGasLimit", "verificationGasLimit", "preVerificationGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"];
const gas = Object.fromEntries(gasFields.map(k => [k, prepared[k] == null ? null : prepared[k].toString()]));
const fee = prepared.maxFeePerGas == null ? null : prepared.maxFeePerGas.toString();
const totalGas = gasFields.reduce((sum, k) => sum + (prepared[k] ?? 0n), 0n);
const maxCost = prepared.maxFeePerGas == null ? null : (totalGas * prepared.maxFeePerGas).toString();

console.log(JSON.stringify({
  mode: "DEPLOYMENT PLAN ONLY — USEROP PREPARED, NOT SIGNED OR SENT",
  network: base.name,
  chainId: 8453,
  deployerEOA: owner.address,
  smartAccount: account.address,
  smartAccountAlreadyDeployed: Boolean(smartCode && smartCode !== "0x"),
  noteAboutOwnership: "Contract owner is the EOA derived from WALLET_PRIVATE_KEY, matching executor.js signer. Smart account is only the sponsored CREATE2 deployer; it is not the contract owner.",
  aaveProvider: provider,
  verifiedAavePool: getAddress(providerPool),
  create2Factory,
  create2FactoryCodePresent: true,
  contract: "AaveV3FlashArb",
  compiler: solc.version(),
  optimizer: { enabled: true, runs: 200 },
  constructorOwner: owner.address,
  executorEOAOwnerMatches: owner.address.toLowerCase() === owner.address.toLowerCase(),
  predictedContractAddress: predictedAddress,
  initCodeHash: keccak256(initCode),
  creationBytecodeBytes: (creationBytecode.length - 2) / 2,
  paymasterAttached: hasPaymaster,
  paymasterAddress,
  userOperationGas: gas,
  maxFeePerGasWei: fee,
  conservativeMaxGasCostWei: maxCost,
  note: "A prepared sponsored UserOperation is not a guarantee of final inclusion. No wallet signature, deployment, or transaction broadcast occurred."
}, null, 2));
