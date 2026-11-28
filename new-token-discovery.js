import "dotenv/config";
import fs from "node:fs";
import { ethers } from "ethers";
import { verifyNewTokenSecurity } from "./token-security.js";

const OUT = new URL("./new-token-watchlist.json", import.meta.url);
const RPC = process.env.RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = 8453;
const MIN_LIQUIDITY_USD = 1000;
const MIN_VOLUME_24H_USD = 500;
const MIN_POOL_AGE_MS = 60000;
const MAX_PROFILES = 200;
const DISCOVERY_CONCURRENCY = 5;
const known = new Set([
  "0x4200000000000000000000000000000000000006",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22",
  "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a",
  "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452",
  "0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee",
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"
]);
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function metadata(address) {
  if (await provider.getCode(address) === "0x") return null;
  const token = new ethers.Contract(address, [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)"
  ], provider);
  try {
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    if (!/^[A-Za-z0-9._-]{1,20}$/.test(symbol) || Number(decimals) > 36) return null;
    return { symbol, decimals: Number(decimals) };
  } catch {
    return null;
  }
}

async function main() {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) throw new Error("Discovery RPC is not Base Mainnet");

  const profiles = await getJson("https://api.dexscreener.com/token-profiles/latest/v1");
  const profileList = Array.isArray(profiles) ? profiles : [];
  const candidates = profileList
    .filter(item => String(item.chainId ?? "").toLowerCase() === "base" && ethers.isAddress(item.tokenAddress))
    .slice(0, MAX_PROFILES);

  let rejectedSecurity = 0;
  let pairRequests = 0;
  let pairRequestErrors = 0;
  let pairsReturned = 0;
  let noEligiblePair = 0;
  let metadataFailures = 0;
  const found = [];

  async function inspectProfile(profile) {
    const address = ethers.getAddress(profile.tokenAddress);
    const key = address.toLowerCase();
    if (known.has(key)) return null;

    try {
      pairRequests++;
      const pairs = await getJson(`https://api.dexscreener.com/token-pairs/v1/base/${address}`);
      const pairList = Array.isArray(pairs) ? pairs : [];
      pairsReturned += pairList.length;
      const eligible = pairList
        .filter(pair => {
          const baseAddress = String(pair.baseToken?.address ?? "").toLowerCase();
          const quoteAddress = String(pair.quoteToken?.address ?? "").toLowerCase();
          const tokenIsInPair = baseAddress === key || quoteAddress === key;
          const otherAddress = baseAddress === key ? quoteAddress : baseAddress;
          const createdAt = Number(pair.pairCreatedAt ?? 0);
          return String(pair.chainId ?? "").toLowerCase() === "base" &&
          tokenIsInPair &&
          ethers.isAddress(otherAddress) &&
          otherAddress !== key &&
          Number(pair.liquidity?.usd ?? 0) >= MIN_LIQUIDITY_USD &&
          Number(pair.volume?.h24 ?? 0) >= MIN_VOLUME_24H_USD &&
          createdAt > 0 &&
          Date.now() - createdAt >= MIN_POOL_AGE_MS;
        })
        .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0));

      if (!eligible.length) {
        noEligiblePair++;
        return null;
      }

      const [meta, security] = await Promise.all([
        metadata(address),
        verifyNewTokenSecurity(address).catch(error => ({ passed: false, reason: error.message }))
      ]);
      if (!meta) {
        metadataFailures++;
        return null;
      }
      if (!security.passed) {
        rejectedSecurity++;
        console.warn(`Security rejected ${address}: ${security.reason}`);
        return null;
      }

      const pair = eligible[0];
      return {
        symbol: meta.symbol,
        address,
        decimals: meta.decimals,
        pairAddress: pair.pairAddress,
        dexId: pair.dexId,
        liquidityUsd: Number(pair.liquidity.usd),
        volume24hUsd: Number(pair.volume.h24),
        poolAgeMinutes: Math.floor((Date.now() - Number(pair.pairCreatedAt)) / 60000),
        priceUsd: pair.priceUsd ?? null,
        discoveryOnly: true,
        safetyPassed: true,
        safetyProvider: security.provider,
        safetyCheckedAt: security.checkedAt,
        safetyChecks: security.checks
      };
    } catch (error) {
      pairRequestErrors++;
      console.warn(`Skipping ${address}: ${error.message}`);
      return null;
    }
  }

  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= candidates.length) return;
      const token = await inspectProfile(candidates[index]);
      if (token) found.push(token);
    }
  }

  await Promise.all(Array.from({ length: DISCOVERY_CONCURRENCY }, () => worker()));
  const unique = new Map(found.map(token => [token.address.toLowerCase(), token]));
  const tokens = [...unique.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);

  fs.writeFileSync(OUT, JSON.stringify({
    chainId: CHAIN_ID,
    checkedAt: new Date().toISOString(),
    filters: {
      minLiquidityUsd: MIN_LIQUIDITY_USD,
      minVolume24hUsd: MIN_VOLUME_24H_USD,
      minPoolAgeMinutes: MIN_POOL_AGE_MS / 60000
    },
    securityPolicy: "GoPlus open-source DEX token, explicit zero buy/sell/transfer tax, and all required risk flags explicitly zero. Unknown data blocks execution.",
    executionEnabled: true,
    tokens,
    rejectedSecurity
  }, null, 2));

  console.log(`DexScreener discovery diagnostics: ${JSON.stringify({
    profilesReturned: profileList.length,
    baseProfiles: candidates.length,
    maxProfiles: MAX_PROFILES,
    pairRequests,
    pairRequestErrors,
    pairsReturned,
    noEligiblePair,
    metadataFailures
  })}`);
  console.log(`New Base token discovery: ${tokens.length} security-passed token(s); ${rejectedSecurity} rejected.`);
  for (const token of tokens.slice(0, 20)) {
    console.log(`${token.symbol} ${token.address} | liq=$${token.liquidityUsd} | vol24h=$${token.volume24hUsd} | age=${token.poolAgeMinutes}m | GoPlus=PASS`);
  }
}

main().catch(error => {
  console.error("New-token discovery failed; continuing safely with no new tokens:", error.message);
  fs.writeFileSync(OUT, JSON.stringify({
    chainId: CHAIN_ID,
    checkedAt: new Date().toISOString(),
    executionEnabled: false,
    tokens: [],
    discoveryError: error.message
  }, null, 2));
});
