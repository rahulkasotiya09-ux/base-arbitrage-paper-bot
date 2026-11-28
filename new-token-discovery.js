import "dotenv/config";
import fs from "node:fs";
import { ethers } from "ethers";

const OUT = new URL("./new-token-watchlist.json", import.meta.url);
const RPC = process.env.RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = 8453;
const MIN_LIQUIDITY_USD = 1000;
const MIN_VOLUME_24H_USD = 500;
const MIN_POOL_AGE_MS = 60000;
const MAX_CANDIDATES = 200;
// Serialize metadata RPC calls to avoid bursts against the Base RPC endpoint.
const DISCOVERY_CONCURRENCY = 1;
const GECKO_NEW_POOL_PAGES = 3;
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

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("HTTP " + response.status + " from " + url);
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

function addCandidate(map, address, source) {
  if (!ethers.isAddress(address)) return;
  const normalized = ethers.getAddress(address);
  const key = normalized.toLowerCase();
  if (known.has(key)) return;
  if (!map.has(key)) map.set(key, { address: normalized, sources: new Set() });
  map.get(key).sources.add(source);
}

async function main() {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) throw new Error("Discovery RPC is not Base Mainnet");

  const candidateMap = new Map();
  const diagnostics = {
    profilesReturned: 0,
    profileBaseCandidates: 0,
    latestBoostsReturned: 0,
    topBoostsReturned: 0,
    takeoverProfilesReturned: 0,
    geckoPagesSucceeded: 0,
    geckoPoolsReturned: 0,
    geckoBasePools: 0,
    geckoPoolsPassingMarketFilters: 0,
    geckoTokenCandidates: 0
  };

  // DexScreener profile/boost lists are global promotional feeds, not complete chain-wide token feeds.
  const feeds = [
    ["profiles", "https://api.dexscreener.com/token-profiles/latest/v1"],
    ["latestBoosts", "https://api.dexscreener.com/token-boosts/latest/v1"],
    ["topBoosts", "https://api.dexscreener.com/token-boosts/top/v1"],
    ["takeovers", "https://api.dexscreener.com/community-takeovers/latest/v1"]
  ];

  await Promise.all(feeds.map(async ([source, url]) => {
    try {
      const response = await getJson(url);
      const list = Array.isArray(response) ? response : [];
      if (source === "profiles") diagnostics.profilesReturned = list.length;
      if (source === "latestBoosts") diagnostics.latestBoostsReturned = list.length;
      if (source === "topBoosts") diagnostics.topBoostsReturned = list.length;
      if (source === "takeovers") diagnostics.takeoverProfilesReturned = list.length;

      for (const item of list) {
        if (String(item.chainId ?? "").toLowerCase() !== "base") continue;
        addCandidate(candidateMap, item.tokenAddress, source);
      }
    } catch (error) {
      console.warn("Discovery feed " + source + " unavailable: " + error.message);
    }
  }));
  diagnostics.profileBaseCandidates = [...candidateMap.values()]
    .filter(item => item.sources.has("profiles")).length;

  // GeckoTerminal's Base new-pools feed discovers actual newly created pools,
  // rather than relying only on DexScreener's small global promotional lists.
  const geckoHeaders = { Accept: "application/json;version=20230203" };
  for (let page = 1; page <= GECKO_NEW_POOL_PAGES; page++) {
    try {
      const url = "https://api.geckoterminal.com/api/v2/networks/base/new_pools?include=base_token%2Cquote_token%2Cdex&page=" + page;
      const response = await getJson(url, geckoHeaders);
      diagnostics.geckoPagesSucceeded++;
      const pools = Array.isArray(response.data) ? response.data : [];
      diagnostics.geckoPoolsReturned += pools.length;
      const included = new Map((Array.isArray(response.included) ? response.included : [])
        .filter(item => item.type === "token")
        .map(item => [item.id, item.attributes ?? {}]));

      for (const pool of pools) {
        const attrs = pool.attributes ?? {};
        const baseId = pool.relationships?.base_token?.data?.id;
        const quoteId = pool.relationships?.quote_token?.data?.id;
        const baseToken = included.get(baseId);
        const quoteToken = included.get(quoteId);
        const createdAt = Date.parse(attrs.pool_created_at ?? "");
        const ageMs = Date.now() - createdAt;
        const liquidity = Number(attrs.reserve_in_usd ?? 0);
        const volume24h = Number(attrs.volume_usd?.h24 ?? 0);

        if (String(pool.id ?? "").toLowerCase().startsWith("base_")) diagnostics.geckoBasePools++;
        if (!Number.isFinite(createdAt) || ageMs < MIN_POOL_AGE_MS ||
            liquidity < MIN_LIQUIDITY_USD || volume24h < MIN_VOLUME_24H_USD) continue;

        diagnostics.geckoPoolsPassingMarketFilters++;
        const before = candidateMap.size;
        if (baseToken?.address) addCandidate(candidateMap, baseToken.address, "geckoNewPools");
        if (quoteToken?.address) addCandidate(candidateMap, quoteToken.address, "geckoNewPools");
        diagnostics.geckoTokenCandidates += candidateMap.size - before;
      }
    } catch (error) {
      console.warn("GeckoTerminal Base new-pools page " + page + " unavailable: " + error.message);
    }
  }

  const candidates = [...candidateMap.values()].slice(0, MAX_CANDIDATES);
  let pairRequests = 0;
  let pairRequestErrors = 0;
  let pairsReturned = 0;
  let noEligiblePair = 0;
  let metadataFailures = 0;
  const found = [];

  async function inspectCandidate(candidate) {
    const address = candidate.address;
    const key = address.toLowerCase();

    try {
      pairRequests++;
      const pairs = await getJson("https://api.dexscreener.com/token-pairs/v1/base/" + address);
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

      const meta = await metadata(address);
      if (!meta) {
        metadataFailures++;
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
        discoverySources: [...candidate.sources],
        discoveryOnly: true,
        marketFiltersPassed: true
      };
    } catch (error) {
      pairRequestErrors++;
      console.warn("Skipping " + address + ": " + error.message);
      return null;
    }
  }

  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= candidates.length) return;
      const token = await inspectCandidate(candidates[index]);
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
    discoverySources: [
      "DexScreener latest profiles",
      "DexScreener latest and top boosts",
      "DexScreener community takeovers",
      "GeckoTerminal Base new pools (first " + GECKO_NEW_POOL_PAGES + " pages)"
    ],
    tokenEligibility: "Eligible when a Base pool meets the configured liquidity/volume/age filters; the scanner must obtain buy and sell quotes and calculate positive net profit.",
    executionEnabled: true,
    tokens
  }, null, 2));

  console.log("Token discovery source diagnostics: " + JSON.stringify({
    ...diagnostics,
    uniqueCandidates: candidates.length,
    maxCandidates: MAX_CANDIDATES,
    pairRequests,
    pairRequestErrors,
    pairsReturned,
    noEligiblePair,
    metadataFailures
  }));
  console.log("New Base token discovery: " + tokens.length + " market-filtered token(s).");
  for (const token of tokens.slice(0, 20)) {
    console.log(token.symbol + " " + token.address + " | liq=$" + token.liquidityUsd +
      " | vol24h=$" + token.volume24hUsd + " | age=" + token.poolAgeMinutes +
      "m | sources=" + token.discoverySources.join(","));
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
