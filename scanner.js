import "dotenv/config";
import fs from "node:fs";
import { ethers } from "ethers";

// Scanner is advisory only; executor independently re-quotes before any simulation.
const cfg = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const rpc = process.env.RPC_URL;
if (!rpc) throw new Error("Set RPC_URL in .env (use a trusted Ethereum RPC endpoint).");

const provider = new ethers.JsonRpcProvider(rpc, cfg.chainId, { staticNetwork: true });
// Keep quote traffic off a single public RPC. Optional private/provider endpoints can
// be supplied through RPC_FALLBACK_URLS (comma-separated); public Base endpoints are
// defaults so the scanner improves immediately without requiring another secret.
const fallbackRpcUrls = (process.env.RPC_FALLBACK_URLS ??
  "https://base-rpc.publicnode.com,https://base.llamarpc.com")
  .split(",").map(url => url.trim()).filter(Boolean);
const quoteRpcUrls = [...new Set([rpc, ...fallbackRpcUrls])];
const quoteProviders = quoteRpcUrls.map(url => new ethers.JsonRpcProvider(url, cfg.chainId));
const quoteRetryStats = { retries: 0, recovered: 0, exhausted: 0 };
let quoteProviderCursor = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const V2_ABI = ["function getAmountsOut(uint amountIn,address[] calldata path) view returns (uint[] memory amounts)"];
const V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)"
];
const AAVE_PROVIDER_ABI = ["function getPool() view returns (address)"];
const AAVE_POOL_ABI = ["function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)"];
const AAVE_RESERVE_ABI = ["function balanceOf(address) view returns (uint256)"];
const AAVE_PROVIDER = cfg.aaveAddressesProvider;

// Build venue contracts against each quote endpoint; the primary provider remains
// responsible for the canonical scan block and executor-side verification.
const quoteContracts = quoteProviders.map(quoteProvider => {
  const contracts = new Map();
  for (const venue of cfg.venues) {
    if (venue.type === "v2") contracts.set(venue.name, new ethers.Contract(venue.router, V2_ABI, quoteProvider));
    if (venue.type === "v3") contracts.set(venue.name, new ethers.Contract(venue.quoter, V3_QUOTER_ABI, quoteProvider));
  }
  return contracts;
});
const discoveredPath = new URL("./new-token-watchlist.json", import.meta.url);
let discoveredTokens = {};
try {
  const watchlist = JSON.parse(fs.readFileSync(discoveredPath, "utf8"));
  for (const token of (watchlist.tokens ?? []).slice().sort((a, b) => Number(b.liquidityUsd ?? 0) - Number(a.liquidityUsd ?? 0)).slice(0, 50)) {
    if (token?.marketFiltersPassed === true &&
        Number(token.liquidityUsd ?? 0) >= 1000 &&
        token?.symbol && token?.address && Number.isInteger(token.decimals) &&
        !Object.prototype.hasOwnProperty.call(cfg.tokens, token.symbol)) {
      discoveredTokens[token.symbol] = {
        address: ethers.getAddress(token.address),
        decimals: token.decimals,
        discoveryOnly: true
      };
    }
  }
} catch { /* Discovery may be unavailable; continue with configured tokens. */ }
const allTokens = { ...cfg.tokens, ...discoveredTokens };
const tokenEntries = Object.entries(allTokens);
const parse = (n, d) => ethers.parseUnits(String(n), d);

const quoteFailureKinds = Object.create(null);
const quoteVenueStats = Object.fromEntries(cfg.venues.map(venue => [venue.name, {
  calls: 0, successes: 0, failures: 0, failureKinds: {}
}]));

async function quote(venue, tokenIn, tokenOut, amountIn, fee, blockTag) {
  const venueStats = quoteVenueStats[venue.name];
  venueStats.calls++;
  const firstProvider = quoteProviderCursor++ % quoteProviders.length;
  let lastError;
  for (let attempt = 0; attempt < quoteProviders.length; attempt++) {
    const providerIndex = (firstProvider + attempt) % quoteProviders.length;
    try {
      const contract = quoteContracts[providerIndex].get(venue.name);
      let result;
      if (venue.type === "v2") {
        const amounts = await contract.getAmountsOut(amountIn, [tokenIn.address, tokenOut.address], { blockTag });
        result = amounts[1];
      } else {
        const q = await contract.quoteExactInputSingle.staticCall({
          tokenIn: tokenIn.address, tokenOut: tokenOut.address,
          amountIn, fee, sqrtPriceLimitX96: 0
        }, { blockTag });
        result = q.amountOut ?? q[0];
      }
      venueStats.successes++;
      if (attempt > 0) quoteRetryStats.recovered++;
      return result;
    } catch (error) {
      lastError = error;
      const kind = classifyQuoteError(error);
      // A genuine missing-pool/revert result is not an RPC outage; don't waste
      // time asking every endpoint the same question.
      if (kind === "no_pool_or_liquidity") break;
      if (attempt + 1 < quoteProviders.length) {
        quoteRetryStats.retries++;
        await wait((kind === "rpc_rate_limited" ? 350 : 150) * (attempt + 1));
      }
    }
  }
  const kind = classifyQuoteError(lastError);
  quoteRetryStats.exhausted++;
  quoteFailureKinds[kind] = (quoteFailureKinds[kind] ?? 0) + 1;
  venueStats.failures++;
  venueStats.failureKinds[kind] = (venueStats.failureKinds[kind] ?? 0) + 1;
  return null;
}

function classifyQuoteError(error) {
  const message = [
    error?.shortMessage, error?.reason, error?.message,
    error?.info?.error?.message, error?.cause?.message, error
  ].filter(Boolean).join(" ").toLowerCase();
  if (/429|rate.?limit|too many requests|25\/second|request limit/.test(message)) return "rpc_rate_limited";
  if (/timeout|timed out|etimedout|econnreset|econnrefused|eai_again|socket hang up|failed to fetch|network_error|server_error|502|503|504|520|522|524/.test(message)) return "rpc_transient";
  if (/insufficient liquidity|insufficient_output|pool does not exist|call_exception|execution reverted|missing revert data/.test(message)) return "no_pool_or_liquidity";
  return "other_quote_error";
}

const quoteCache = new Map();
function cachedQuote(venue, tokenIn, tokenOut, amountIn, fee, blockTag) {
  const key = [venue.name, tokenIn.address.toLowerCase(), tokenOut.address.toLowerCase(),
    amountIn.toString(), fee, blockTag].join(":");
  if (!quoteCache.has(key)) quoteCache.set(key, quote(venue, tokenIn, tokenOut, amountIn, fee, blockTag));
  return quoteCache.get(key);
}
// Keep RPC pressure below common public Base endpoint limits. Override only
// with a provider whose documented request capacity supports higher concurrency.
const configuredConcurrency = Number(process.env.SCAN_CONCURRENCY ?? 4);
const SCAN_CONCURRENCY = Number.isInteger(configuredConcurrency)
  ? Math.max(1, Math.min(8, configuredConcurrency)) : 4;
async function runBounded(items, concurrency, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }));
}

function feeOptions(v) { return v.type === "v3" ? v.fees : [0]; }

async function notifyTelegram(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({chat_id: chatId, text: message, disable_web_page_preview: true})
    });
    if (!res.ok) console.error("Telegram alert failed:", await res.text());
  } catch (err) { console.error("Telegram alert error:", err.message); }
}

async function main() {
  const [network, block, feeData] = await Promise.all([
    provider.getNetwork(), provider.getBlockNumber(), provider.getFeeData()
  ]);
  if (Number(network.chainId) !== cfg.chainId) throw new Error(`RPC chain mismatch: expected ${cfg.chainId}, got ${network.chainId}`);
  for (const venue of cfg.venues) {
    const target = venue.type === "v2" ? venue.router : venue.quoter;
    if (!target || (await provider.getCode(target, block)) === "0x") throw new Error(`Configured ${venue.name} contract has no code at ${target}`);
  }
  const poolProvider = new ethers.Contract(AAVE_PROVIDER, AAVE_PROVIDER_ABI, provider);
  const poolAddress = await poolProvider.getPool({ blockTag: block });
  const pool = new ethers.Contract(poolAddress, AAVE_POOL_ABI, provider);
  const premiumBps = BigInt(await pool.FLASHLOAN_PREMIUM_TOTAL({ blockTag: block }));
  // Scan the actual configured V2 and V3 venues. V3 candidates carry their fee
  // tiers into opportunities.json; executor.js independently verifies on-chain
  // routerType/factory approvals before simulation or any explicitly enabled broadcast.
  const scanVenues = cfg.venues.filter(venue =>
    (venue.type === "v2" && venue.router) ||
    (venue.type === "v3" && venue.router && venue.factory && venue.quoter && Array.isArray(venue.fees))
  );
  if (scanVenues.length < 2) throw new Error("At least two configured V2/V3 venues are required for arbitrage scanning");
  const rows = [];
  const stats = {
    routeQuotesAttempted: 0, quoteFailures: 0, insufficientFlashLiquidity: 0,
    rejectedBeforeGas: 0, rejectedAfterGas: 0, profitableIndicative: 0,
    scanConcurrency: SCAN_CONCURRENCY
  };
  const tasks = [];
  for (const amounts of cfg.scanAmounts) {
    const baseToken = cfg.tokens[amounts.token];
    if (!baseToken || amounts.token !== "WETH") continue;
    const reserve = new ethers.Contract(baseToken.address, AAVE_RESERVE_ABI, provider);
    const reserveBalance = await reserve.balanceOf(poolAddress, { blockTag: block });
    for (const [midName, midToken] of tokenEntries) {
      if (midName === amounts.token || midToken.address.toLowerCase() === baseToken.address.toLowerCase()) continue;
      for (const amountText of amounts.amounts) {
        const amountIn = parse(amountText, baseToken.decimals);
        if (amountIn > reserveBalance) { stats.insufficientFlashLiquidity++; continue; }
        for (const buy of scanVenues) for (const sell of scanVenues) {
          if (buy.name === sell.name) continue;
          for (const buyFee of feeOptions(buy)) for (const sellFee of feeOptions(sell)) {
            tasks.push({ amounts, baseToken, midName, midToken, amountText, amountIn, buy, sell, buyFee, sellFee });
          }
        }
      }
    }
  }

  await runBounded(tasks, SCAN_CONCURRENCY, async task => {
    const { amounts, baseToken, midName, midToken, amountText, amountIn, buy, sell, buyFee, sellFee } = task;
    stats.routeQuotesAttempted++;
    const midOut = await cachedQuote(buy, baseToken, midToken, amountIn, buyFee, block);
    if (midOut === null || midOut === 0n) { stats.quoteFailures++; return; }
    stats.routeQuotesAttempted++;
    const baseOut = await cachedQuote(sell, midToken, baseToken, midOut, sellFee, block);
    if (baseOut === null) { stats.quoteFailures++; return; }
    const premium = amountIn * premiumBps / 10000n;
    const amountOwed = amountIn + premium;
    if (baseOut <= amountOwed) { stats.rejectedBeforeGas++; return; }
    const gross = baseOut - amountOwed;
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (baseToken.address.toLowerCase() !== cfg.wrappedNative.toLowerCase() || !gasPrice) return;
    // Advisory scanner estimates are route-specific and intentionally lower
    // than the executor's final measured gas. The executor still performs an
    // exact estimate, L1 fee calculation and full transaction simulation.
    const scannerGasUnits = buy.type === "v3" && sell.type === "v3" ? 550000n
      : buy.type === "v3" || sell.type === "v3" ? 450000n : 350000n;
    const gasCostBase = scannerGasUnits * gasPrice;
    if (gross <= gasCostBase) { stats.rejectedAfterGas++; return; }
    const net = gross - gasCostBase;
    if (net > 0n) {
      stats.profitableIndicative++;
      rows.push({
        block, base: amounts.token, intermediate: midName, newlyDiscovered: Boolean(midToken.discoveryOnly), amountIn: amountText,
        buyVenue: buy.name, buyType: buy.type, buyFee,
        sellVenue: sell.name, sellType: sell.type, sellFee,
        buyRouter: buy.router,
        sellRouter: sell.router,
        intermediateAddress: midToken.address,
        intermediateDecimals: midToken.decimals,
        executorCompatible: true,
        intermediateOut: ethers.formatUnits(midOut, midToken.decimals),
        intermediateOutRaw: midOut.toString(),
        finalOut: ethers.formatUnits(baseOut, baseToken.decimals),
        finalOutRaw: baseOut.toString(),
        flashPremium: ethers.formatUnits(premium, baseToken.decimals),
        flashLoanPremiumBps: premiumBps.toString(),
        grossProfit: ethers.formatUnits(gross, baseToken.decimals),
        estimatedGasCost: ethers.formatUnits(gasCostBase, baseToken.decimals),
        estimatedNetProfit: ethers.formatUnits(net, baseToken.decimals),
        estimatedNetProfitRaw: net.toString(),
        gasPriceWei: gasPrice.toString(),
        gasAdjusted: true,
        scannerGasUnits: scannerGasUnits.toString(),
        quoteBlock: block,
        l1DataFeeIncluded: false,
        executionReady: true,
        note: "Preliminary filter only. New and established tokens use the same executor eligibility; executor still requires on-chain token/router approvals, fresh quotes, full gas accounting, and exact transaction simulation."
      });
    }
  });
  rows.sort((a,b) => {
    const av = ethers.parseUnits(a.estimatedNetProfit, cfg.tokens[a.base].decimals);
    const bv = ethers.parseUnits(b.estimatedNetProfit, cfg.tokens[b.base].decimals);
    return av === bv ? 0 : (av > bv ? -1 : 1);
  });
  const output = {
    chainId: cfg.chainId, block, checkedAt: new Date().toISOString(),
    flashLoanPremiumBps: premiumBps.toString(),
    gasPriceWei: (feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n).toString(),
    gasLimitEstimate: cfg.gasLimitEstimate,
    stats: { ...stats, quoteFailureKinds, quoteVenueStats, quoteRetryStats, quoteRpcEndpoints: quoteProviders.length },
    candidates: rows
  };
  fs.writeFileSync("opportunities.json", JSON.stringify(output, null, 2));
  if (rows.length) {
    const top = rows.slice(0, 5).map(r =>
      `${r.base} ${r.amountIn} | ${r.buyVenue} -> ${r.sellVenue} | estimated net: ${r.estimatedNetProfit}`
    ).join("\n");
    await notifyTelegram(`FlashArb scanner: ${rows.length} candidate(s) at block ${block}\n\n${top}\n\nQuotes are indicative only. NOT EXECUTABLE / NOT GUARANTEED.`);
  }
  console.log(`Scanned block ${block}. ${rows.length} preliminary candidate(s) written to opportunities.json`);
  if (rows.some(r => !r.executionReady)) console.log("V2 and V3 routes are quoted; executor independently validates the router type, factory/pool and exact simulation.");
  for (const r of rows.slice(0, 20)) console.log(`${r.base} ${r.amountIn} | ${r.buyVenue} -> ${r.sellVenue} | net=${r.estimatedNetProfit}`);
  console.log("Scan diagnostics:", JSON.stringify({ ...stats, quoteFailureKinds, quoteVenueStats, quoteRetryStats, quoteRpcEndpoints: quoteProviders.length }));
  if (!rows.length) console.log("No candidates had positive indicative profit after Aave premium and estimated L2 gas. Final L1 fee and safety buffer are checked by executor.");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
