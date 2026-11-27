import "dotenv/config";
import { createPublicClient, getAddress, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address } from "viem/account-abstraction";
import { toSimpleSmartAccount } from "permissionless/accounts";

const rpc = process.env.BASE_RPC_URL || "https://mainnet.base.org";
// Reuse the existing GitHub Actions wallet secret, without printing or exporting its value.
const rawKey = (process.env.WALLET_PRIVATE_KEY || process.env.BASE_MAINNET_OWNER_PRIVATE_KEY || "").trim();
if (!rawKey) throw new Error("Missing WALLET_PRIVATE_KEY GitHub secret.");
const privateKey = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("WALLET_PRIVATE_KEY must be 64 hex characters, optionally prefixed by 0x.");

const providerAddress = getAddress(process.env.AAVE_POOL_ADDRESSES_PROVIDER || "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D");
const expectedPool = getAddress(process.env.AAVE_POOL_EXPECTED || "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
const client = createPublicClient({ chain: base, transport: http(rpc) });
const chainId = await client.getChainId();
if (chainId !== 8453) throw new Error("Wrong network: expected Base 8453, got " + chainId);

const owner = privateKeyToAccount(privateKey);
const smartAccount = await toSimpleSmartAccount({ client, owner, entryPoint: { address: entryPoint07Address, version: "0.7" } });
const providerAbi = [{ type: "function", name: "getPool", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const actualPool = getAddress(await client.readContract({ address: providerAddress, abi: providerAbi, functionName: "getPool" }));
if (actualPool !== expectedPool) throw new Error("Aave Pool mismatch: expected " + expectedPool + ", got " + actualPool);
const [providerCode, poolCode, smartAccountCode, nativeBalance] = await Promise.all([
  client.getCode({ address: providerAddress }),
  client.getCode({ address: actualPool }),
  client.getCode({ address: smartAccount.address }),
  client.getBalance({ address: owner.address })
]);
if (!providerCode || providerCode === "0x" || !poolCode || poolCode === "0x") throw new Error("Aave provider or Pool has no contract code.");
console.log(JSON.stringify({
  mode: "READ-ONLY BASE MAINNET DEPLOYMENT PREPARATION — NO TRANSACTION SENT",
  network: base.name, chainId, deployerEOA: owner.address,
  intendedContractOwnerSmartAccount: smartAccount.address, entryPoint: entryPoint07Address,
  aaveProvider: providerAddress, verifiedPool: actualPool,
  smartAccountAlreadyDeployed: Boolean(smartAccountCode && smartAccountCode !== "0x"),
  deployerNativeBalanceWei: nativeBalance.toString(), deployerHasNativeGas: nativeBalance > 0n,
  note: "Existing WALLET_PRIVATE_KEY secret reused for address derivation only; no signing or transaction broadcast.",
  nextRequirements: [
    "Confirm Base mainnet sponsorship is enabled and funded in Pimlico; API key presence alone does not prove sponsorship.",
    "Review and separately approve exact deployment bytecode, constructor arguments, deployer, and gas cost before any deployment transaction."
  ]
}, null, 2));
