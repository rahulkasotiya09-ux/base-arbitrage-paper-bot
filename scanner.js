import "dotenv/config";
import fs from "node:fs";
import { ethers } from "ethers";

// Scanner is advisory only; executor independently re-quotes before any simulation.
const cfg = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const configuredRpc = process.env.RPC_URL;
if (!configuredRpc) throw new Error("Set RPC_URL in .env (use a trusted Ethereum RPC endpoint).");
// The public mainnet.base.org endpoint is aggressively rate-limited. When it is
// the workflow default, use PublicNode for general reads and retain the configured
// endpoint as a quote fallback. Explicit user-supplied RPC URLs remain preferred.
const rpc = configuredRpc.replace(/\/$/, "") === "https://mainnet.base.org"
  ? "https://base-rpc.publicnode.com" : configuredRpc;
const provider = new ethers.JsonRpcProvider(rpc, cfg.chainId, { staticNetwork: true });
// Keep quote traffic off a single public RPC. Optional private/provider endpoints can
// be supplied through RPC_FALLBACK_URLS (comma-separated); public Base endpoints are
// defaults so the scanner improves immediately without requiring another secret.
const fallbackRpcUrls = (process.env.RPC_FALLBACK_URLS ??
  "https://base-rpc.publicnode.com,https://base.llamarpc.com")
  .split(",").map(url => url.trim()).filter(Boolean);
const quoteRpcUrls = [...new Set([rpc, ...fallbackRpcUrls, configuredRpc])];
const quoteProviders = quoteRpcUrls.map(url => new ethers.JsonRpcProvider(url, cfg.chainId, { staticNetwork: true }));
const quoteRetryStats = { retries: 0, recovered: 0, exhausted: 0 };
let quoteProviderCursor = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const V2_ABI = ["function getAmountsOut(uint amountIn,address[] calldata path) view returns (uint[] memory amounts)"];
const V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)"
];
const V4_QUOTER_ABI = [
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)"
];
const AERODROME_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn,tuple(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)"
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
    if (venue.type === "v4") contracts.set(venue.name, new ethers.Contract(venue.quoter, V4_QUOTER_ABI, quoteProvider));
    if (venue.type === "aerodrome") contracts.set(venue.name, new ethers.Contract(venue.router, AERODROME_ROUTER_ABI, quoteProvider));
  }
  return contracts;
});
const discoveredPath = new URL("./new-token-watchlist.json", import.meta.url);
let discoveredTokens = {};
try {
  const watchlist = JSON.parse(fs.readFileSync(discoveredPath, "utf8"));
  for (const token of (watchlist.tokens ?? []).slice().sort((a, b) => Number(b.liquidityUsd ?? 0) - Number(a.liquidityUsd ?? 0)).slice(0, 75)) {
    if (token?.marketFiltersPassed === true &&
        Number(token.liquidityUsd ?? 0) >= 1000 &&
        token?.symbol && token?.address && Number.isInteger(token.decimals) &&
        !Object.prototype.hasOwnProperty.call(cfg.tokens, token.symbol)) {
      discoveredTokens[token.symbol] = {
        address: ethers.getAddress(token.address),
        decimals: token.decimals,
        discoveryOnly: true,
        liquidityUsd: Number(token.liquidityUsd ?? 0)
      };
    }
  }
} catch { /* Discovery may be unavailable; continue with configured tokens. */ }
const allTokens = { ...cfg.tokens, ...discoveredTokens };
const tokenEntries = Object.entries(allTokens);
const parse = (n, d) => ethers.parseUnits(String(n), d);

// Add logarithmic midpoint sizes where adjacent configured samples are far apart.
function adaptiveAmountSamples(amounts) {
  const values = [...new Set(amounts.map(String))].sort((a, b) => Number(a) - Number(b));
  const expanded = [...values];
  for (let i = 1; i < values.length; i++) {
    const low = Number(values[i - 1]), high = Number(values[i]);
    if (low > 0 && high / low >= 1.8) {
      const midpoint = Math.sqrt(low * high);
      expanded.push(Number(midpoint.toPrecision(8)).toString());
    }
  }
  return [...new Set(expanded)].sort((a, b) => Number(a) - Number(b));
}

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
      } else if (venue.type === "v4") {
        if (amountIn > (2n ** 128n - 1n)) throw new Error("Uniswap V4 quote amount exceeds uint128");
        const a = BigInt(tokenIn.address), b = BigInt(tokenOut.address);
        const currency0 = a < b ? tokenIn.address : tokenOut.address;
        const currency1 = a < b ? tokenOut.address : tokenIn.address;
        const params = {
          poolKey: { currency0, currency1, fee: fee.fee, tickSpacing: fee.tickSpacing, hooks: ethers.ZeroAddress },
          zeroForOne: a < b,
          exactAmount: amountIn,
          hookData: "0x"
        };
        const q = await contract.quoteExactInputSingle.staticCall(params, { blockTag });
        result = q.amountOut ?? q[0];
      } else if (venue.type === "aerodrome") {
        const amounts = await contract.getAmountsOut(amountIn, [{
          from: tokenIn.address, to: tokenOut.address, stable: Boolean(fee), factory: venue.factory
        }], { blockTag });
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
    amountIn.toString(), fee && typeof fee === "object" ? JSON.stringify(fee) : fee, blockTag].join(":");
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

function feeOptions(v) { return v.type === "v3" || v.type === "v4" ? v.fees : v.type === "aerodrome" ? [false, true] : [0]; }

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
    const target = ["v3", "v4"].includes(venue.type) ? venue.quoter : venue.router;
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
    (venue.type === "v3" && venue.router && venue.factory && venue.quoter && Array.isArray(venue.fees)) ||
    (venue.type === "v4" && venue.quoter && Array.isArray(venue.fees)) ||
    (venue.type === "aerodrome" && venue.router && venue.factory)
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
    const amountSamples = adaptiveAmountSamples(amounts.amounts);
    for (const [midName, midToken] of tokenEntries) {
      if (midName === amounts.token || midToken.address.toLowerCase() === baseToken.address.toLowerCase()) continue;
      for (const amountText of amountSamples) {
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
    const scannerGasUnits = buy.type === "v4" || sell.type === "v4" ? 750000n
      : buy.type === "v3" && sell.type === "v3" ? 550000n
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
        executorCompatible: ["v2", "v3"].includes(buy.type) && ["v2", "v3"].includes(sell.type),
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
        executionStatus: !["v2", "v3"].includes(buy.type) || !["v2", "v3"].includes(sell.type) ? "discovery_only" : "requires_executor_validation",
        note: !["v2", "v3"].includes(buy.type) || !["v2", "v3"].includes(sell.type) ? "Discovery-only quote: the deployed executor does not support every venue in this route. Do not execute until a compatible adapter/contract is deployed and approvals are verified." : "Executor-compatible route only; not execution-ready until on-chain token/router approvals, fresh quotes, full gas accounting, and exact transaction simulation all pass."
      });
    }
  });

  // Bounded three-hop discovery: WETH -> token A -> token B -> WETH.
  // These candidates are discovery-only; the deployed executor remains two-hop.
  const tripleTokens = tokenEntries
    .filter(([name, token]) => name !== "WETH" && token.address.toLowerCase() !== cfg.tokens.WETH.address.toLowerCase())
    .sort((a, b) => Number(b[1].liquidityUsd ?? 0) - Number(a[1].liquidityUsd ?? 0))
    .slice(0, 3);
  const tripleVenues = scanVenues.filter(v => ["v2", "v3", "aerodrome"].includes(v.type));
  const tripleTasks = [];
  const tripleReserveBalance = await new ethers.Contract(
    cfg.tokens.WETH.address, AAVE_RESERVE_ABI, provider
  ).balanceOf(poolAddress, { blockTag: block });
  const tripleReserveWeth = ethers.formatUnits(tripleReserveBalance, cfg.tokens.WETH.decimals);
  // Scale discovery sizes to the actual Aave WETH liquidity. Previously the
  // hard-coded 0.001/0.01 WETH sizes silently skipped every route when reserve
  // liquidity was below 0.001 WETH.
  const reserveEligibleTripleAmounts = ["0.00001", "0.0001", "0.001", "0.01"]
    .filter(amount => parse(amount, cfg.tokens.WETH.decimals) <= tripleReserveBalance);
  const tripleSampleAmounts = reserveEligibleTripleAmounts.length > 2
    ? [reserveEligibleTripleAmounts[0], reserveEligibleTripleAmounts[reserveEligibleTripleAmounts.length - 1]]
    : reserveEligibleTripleAmounts;
  stats.threeHopReserveWeth = tripleReserveWeth;
  stats.threeHopSampleAmounts = tripleSampleAmounts;
  stats.threeHopTokenCount = tripleTokens.length;
  stats.threeHopVenueCount = tripleVenues.length;
  stats.threeHopSkipReason = tripleSampleAmounts.length === 0 ? "Aave WETH reserve below 0.00001 WETH" :
    tripleTokens.length < 2 ? "Fewer than two eligible intermediate tokens" :
    tripleVenues.length < 3 ? "Fewer than three distinct supported venues" : null;
  for (const [firstName, firstToken] of tripleTokens) {
    for (const [secondName, secondToken] of tripleTokens) {
      if (firstName === secondName || firstToken.address.toLowerCase() === secondToken.address.toLowerCase()) continue;
      for (const amountText of tripleSampleAmounts) {
        const amountIn = parse(amountText, cfg.tokens.WETH.decimals);
        for (const firstVenue of tripleVenues)
          for (const secondVenue of tripleVenues)
            for (const thirdVenue of tripleVenues) {
              if (new Set([firstVenue.name, secondVenue.name, thirdVenue.name]).size !== 3) continue;
              for (const firstFee of feeOptions(firstVenue))
                for (const secondFee of feeOptions(secondVenue))
                  for (const thirdFee of feeOptions(thirdVenue)) {
                    tripleTasks.push({ firstName, firstToken, secondName, secondToken, amountText, amountIn,
                      firstVenue, secondVenue, thirdVenue, firstFee, secondFee, thirdFee });
                  }
            }
      }
    }
  }
  stats.threeHopRoutesAttempted = tripleTasks.length;
  stats.threeHopQuoteCalls = 0;
  stats.threeHopQuoteFailures = 0;
  await runBounded(tripleTasks, SCAN_CONCURRENCY, async task => {
    const { firstName, firstToken, secondName, secondToken, amountText, amountIn,
      firstVenue, secondVenue, thirdVenue, firstFee, secondFee, thirdFee } = task;
    stats.threeHopQuoteCalls++;
    const firstOut = await cachedQuote(firstVenue, cfg.tokens.WETH, firstToken, amountIn, firstFee, block);
    if (firstOut === null || firstOut <= 0n) { stats.threeHopQuoteFailures++; return; }
    stats.threeHopQuoteCalls++;
    const secondOut = await cachedQuote(secondVenue, firstToken, secondToken, firstOut, secondFee, block);
    if (secondOut === null || secondOut <= 0n) { stats.threeHopQuoteFailures++; return; }
    stats.threeHopQuoteCalls++;
    const finalOut = await cachedQuote(thirdVenue, secondToken, cfg.tokens.WETH, secondOut, thirdFee, block);
    if (finalOut === null || finalOut <= 0n) { stats.threeHopQuoteFailures++; return; }
    const premium = amountIn * premiumBps / 10000n;
    const owed = amountIn + premium;
    if (finalOut <= owed) { stats.rejectedBeforeGas++; return; }
    const gross = finalOut - owed;
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!gasPrice) return;
    const gasUnits = 850000n;
    const gasCost = gasUnits * gasPrice;
    if (gross <= gasCost) { stats.rejectedAfterGas++; return; }
    const net = gross - gasCost;
    stats.threeHopProfitableIndicative = (stats.threeHopProfitableIndicative ?? 0) + 1;
    rows.push({
      block, base: "WETH", routeHops: 3,
      route: ["WETH", firstName, secondName, "WETH"],
      intermediates: [
        { symbol: firstName, address: firstToken.address, decimals: firstToken.decimals },
        { symbol: secondName, address: secondToken.address, decimals: secondToken.decimals }
      ],
      amountIn: amountText,
      venues: [firstVenue.name, secondVenue.name, thirdVenue.name],
      fees: [firstFee, secondFee, thirdFee],
      grossProfit: ethers.formatUnits(gross, 18),
      estimatedGasCost: ethers.formatUnits(gasCost, 18),
      estimatedNetProfit: ethers.formatUnits(net, 18),
      estimatedNetProfitRaw: net.toString(),
      gasPriceWei: gasPrice.toString(),
      scannerGasUnits: gasUnits.toString(),
      quoteBlock: block,
      gasAdjusted: true,
      l1DataFeeIncluded: false,
      executorCompatible: false,
      executionStatus: "discovery_only",
      note: "Three-hop discovery-only route. Current executor supports two-hop V2/V3 routes only; exact L1 data fee and full simulation are not included."
    });
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
      r.routeHops === 3 ? (r.route.join(" -> ") + " | " + r.amountIn + " WETH | indicative net: " + r.estimatedNetProfit) : (r.base + " " + r.amountIn + " | " + r.buyVenue + " -> " + r.sellVenue + " | estimated net: " + r.estimatedNetProfit)
    ).join("\n");
    await notifyTelegram(`FlashArb scanner: ${rows.length} candidate(s) at block ${block}\n\n${top}\n\nQuotes are indicative only. NOT EXECUTABLE / NOT GUARANTEED.`);
  }
  console.log(`Scanned block ${block}. ${rows.length} preliminary candidate(s) written to opportunities.json`);
  const executorCompatibleCount = rows.filter(r => r.executorCompatible).length;
  const discoveryOnlyCount = rows.length - executorCompatibleCount;
  console.log(`Candidate status: ${executorCompatibleCount} executor-compatible pending validation; ${discoveryOnlyCount} discovery-only (Aerodrome unsupported by current executor).`);
  for (const r of rows.slice(0, 20)) console.log(r.routeHops === 3 ? (r.route.join(" -> ") + " | " + r.amountIn + " WETH | net=" + r.estimatedNetProfit + " (discovery-only)") : (r.base + " " + r.amountIn + " | " + r.buyVenue + " -> " + r.sellVenue + " | net=" + r.estimatedNetProfit));
  console.log("Scan diagnostics:", JSON.stringify({ ...stats, quoteFailureKinds, quoteVenueStats, quoteRetryStats, quoteRpcEndpoints: quoteProviders.length }));
  if (!rows.length) console.log("No candidates had positive indicative profit after Aave premium and estimated L2 gas. Final L1 fee and safety buffer are checked by executor.");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
