import "dotenv/config";
import { createPublicClient, http } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { toSimpleSmartAccount } from "permissionless/accounts";

for (const key of ["BASE_SEPOLIA_RPC_URL", "WALLET_PRIVATE_KEY"]) {
  if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
}

// MetaMask exports the private key without a 0x prefix.
// Accept either 64 hex characters or 0x followed by 64 hex characters.
const rawPrivateKey = process.env.WALLET_PRIVATE_KEY.trim();
const normalizedPrivateKey = rawPrivateKey.startsWith("0x")
  ? rawPrivateKey
  : `0x${rawPrivateKey}`;

if (!/^0x[0-9a-fA-F]{64}$/.test(normalizedPrivateKey)) {
  throw new Error("WALLET_PRIVATE_KEY must contain exactly 64 hexadecimal characters, optionally prefixed with 0x");
}

const owner = privateKeyToAccount(normalizedPrivateKey);
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC_URL)
});
const account = await toSimpleSmartAccount({
  client,
  owner,
  entryPoint: { address: entryPoint07Address, version: "0.7" }
});
console.log(JSON.stringify({
  network: baseSepolia.name,
  chainId: baseSepolia.id,
  ownerEOA: owner.address,
  sponsoredSmartAccount: account.address,
  entryPoint: entryPoint07Address,
  note: "Use sponsoredSmartAccount as the ownerAddress constructor argument when deploying AaveV3FlashArb on Base Sepolia."
}, null, 2));
