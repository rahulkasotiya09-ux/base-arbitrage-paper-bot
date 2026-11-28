import "dotenv/config";
import fs from "node:fs";
import { ethers } from "ethers";

const OUT = new URL("./new-token-watchlist.json", import.meta.url);
const RPC = process.env.RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = 8453;
const MIN_LIQUIDITY_USD = 10000;
const MIN_VOLUME_24H_USD = 5000;
const MIN_POOL_AGE_MS = 5 * 60 * 1000;
const MAX_PROFILES = 30;
const QUOTE_ASSETS = new Set([
  "0x4200000000000000000000000000000000000006",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca"
]);
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
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}
async function metadata(address) {
  if (await provider.getCode(address) === "0x") return null;
  const contract = new ethers.Contract(address, [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)"
  ], provider);
  try {
    const [symbol, decimals] = await Promise.all([contract.symbol(), contract.decimals()]);
    if (!/^[A-Za-z0-9._-]{1,20}$/.test(symbol) || Number(decimals) > 36) return null;
    return { symbol, decimals: Number(decimals) };
  } catch { return null; }
}
async function main() {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) throw new Error("Discovery RPC is not Base Mainnet");
  const profiles = await getJson("https://api.dexscreener.com/token-profiles/latest/v1");
  const candidates = (Array.isArray(profiles) ? profiles : [])
    .filter(x => x.chainId === "base" && ethers.isAddress(x.tokenAddress))
    .slice(0, MAX_PROFILES);
  const bestByToken = new Map();
  for (const profile of candidates) {
    const address = ethers.getAddress(profile.tokenAddress);
    const key = address.toLowerCase();
    if (known.has(key)) continue;
    try {
      const pairs = await getJson(`https://api.dexscreener.com/token-pairs/v1/base/${address}`);
      const eligible = (Array.isArray(pairs) ? pairs : []).filter(pair => {
        const quote = pair.quoteToken?.address?.toLowerCase();
        const liquidity = Number(pair.liquidity?.usd ?? 0);
        const volume = Number(pair.volume?.h24 ?? 0);
        const created = Number(pair.pairCreatedAt ?? 0);
        return pair.chainId === "base" &&
          pair.baseToken?.address?.toLowerCase() === key &&
          QUOTE_ASSETS.has(quote) &&
          liquidity >= MIN_LIQUIDITY_USD &&
          volume >= MIN_VOLUME_24H_USD &&
          created > 0 && Date.now() - created >= MIN_POOL_AGE_MS;
      }).sort((a,b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0));
      if (!eligible.length) continue;
      const meta = await metadata(address);
      if (!meta) continue;
      const pair = eligible[0];
      const item = {
        symbol: meta.symbol, address, decimals: meta.decimals,
        pairAddress: pair.pairAddress, dexId: pair.dexId,
        liquidityUsd: Number(pair.liquidity.usd),
        volume24hUsd: Number(pair.volume.h24),
        poolAgeMinutes: Math.floor((Date.now() - Number(pair.pairCreatedAt)) / 60000),
        priceUsd: pair.priceUsd ?? null, discoveryOnly: true,
        safetyStatus: "UNVERIFIED — honeypot/tax audit not performed; execution disabled"
      };
      const prior = bestByToken.get(key);
      if (!prior || item.liquidityUsd > prior.liquidityUsd) bestByToken.set(key, item);
    } catch (error) { console.warn(`Skipping ${address}: ${error.message}`); }
  }
  const tokens = [...bestByToken.values()].sort((a,b) => b.liquidityUsd - a.liquidityUsd);
  fs.writeFileSync(OUT, JSON.stringify({
    chainId: CHAIN_ID, checkedAt: new Date().toISOString(),
    filters: { minLiquidityUsd: MIN_LIQUIDITY_USD, minVolume24hUsd: MIN_VOLUME_24H_USD, minPoolAgeMinutes: 5 },
    executionEnabled: false, tokens
  }, null, 2));
  console.log(`New Base token discovery: ${tokens.length} token(s) passed filters. All remain execution-disabled.`);
  for (const token of tokens.slice(0, 20)) console.log(`${token.symbol} ${token.address} | liq=$${token.liquidityUsd} | vol24h=$${token.volume24hUsd} | age=${token.poolAgeMinutes}m`);
}
main().catch(error => {
  console.error("New-token discovery failed; continuing safely with no new tokens:", error.message);
  fs.writeFileSync(OUT, JSON.stringify({
    chainId: CHAIN_ID, checkedAt: new Date().toISOString(),
    executionEnabled: false, tokens: [], discoveryError: error.message
  }, null, 2));
});
