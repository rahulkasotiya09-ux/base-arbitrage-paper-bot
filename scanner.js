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
const scannerWallet = process.env.WALLET_PRIVATE_KEY ? new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider) : null;
const scannerExecutor = process.env.EXECUTOR_ADDRESS && scannerWallet ? new ethers.Contract(
  ethers.getAddress(process.env.EXECUTOR_ADDRESS), [
    "function start(address asset,uint256 amount,(address intermediateToken,address buyRouter,address sellRouter,uint256 minIntermediateOut,uint256 minFinalOut,uint256 gasReserveInAsset,uint256 minProfit,uint256 deadline) route)",
    "function startV3(address asset,uint256 amount,(address intermediateToken,address buyRouter,address sellRouter,uint256 minIntermediateOut,uint256 minFinalOut,uint24 buyFee,uint24 sellFee,uint256 gasReserveInAsset,uint256 minProfit,uint256 deadline) route)",
    "function startV4(address asset,uint256 amount,(address intermediateToken,address buyRouter,address sellRouter,uint256 minIntermediateOut,uint256 minFinalOut,uint24 buyFee,uint24 sellFee,int24 buyTickSpacing,int24 sellTickSpacing,uint256 gasReserveInAsset,uint256 minProfit,uint256 deadline) route)",
    "function poolManager() view returns (address)",
    "function routerType(address) view returns (uint8)",
    "function approvedRouter(address) view returns (bool)"
  ], scannerWallet) : null;
// Keep quote traffic off a single public RPC. Optional private/provider endpoints can
// be supplied through RPC_FALLBACK_URLS (comma-separated); public Base endpoints are
// defaults so the scanner improves immediately without requiring another secret.
const fallbackRpcUrls = (process.env.RPC_FALLBACK_URLS ??
  "https://base-rpc.publicnode.com,https://mainnet.base.org")
  .split(",").map(url => url.trim()).filter(Boolean);
const quoteRpcUrls = [...new Set([rpc, ...fallbackRpcUrls, configuredRpc])];
const quoteProviders = quoteRpcUrls.map(url => new ethers.JsonRpcProvider(url, cfg.chainId, { staticNetwork: true }));
const quoteEndpointStats = quoteRpcUrls.map((url, index) => {
  let host = `custom-rpc-${index + 1}`;
  try { host = new URL(url).hostname; } catch {}
  return { endpoint: host, calls: 0, successes: 0, failures: 0, consecutiveTransientFailures: 0,
    totalLatencyMs: 0, maxLatencyMs: 0, failureKinds: {} };
});
const quoteEndpointCooldownUntil = quoteRpcUrls.map(() => 0);
const quoteRetryStats = { retries: 0, recovered: 0, exhausted: 0, skippedCoolingEndpoints: 0 };
let quoteProviderCursor = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const V2_ABI = ["function getAmountsOut(uint amountIn,address[] calldata path) view returns (uint[] memory amounts)"];
const V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)"
];
const V4_QUOTER_ABI = [
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)"
];
const V4_STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)"
];
const V4_POOL_ID_ABI = ethers.AbiCoder.defaultAbiCoder();
// Cache immutable-per-block V4 pool state so parallel routes do not hammer StateView.
const v4PoolStateCache = new Map();
const v4PreflightStats = { checked: 0, uninitialized: 0, zeroActiveLiquidity: 0, initializedWithLiquidity: 0 };
const quoteFailureSamples = [];
const AERODROME_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn,tuple(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)"
];
const AAVE_PROVIDER_ABI = ["function getPool() view returns (address)"];
const AAVE_POOL_ABI = ["function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)"];
const AAVE_RESERVE_ABI = ["function balanceOf(address) view returns (uint256)"];
const AAVE_PROVIDER = cfg.aaveAddressesProvider;
const L1_FEE_ORACLE = "0x420000000000000000000000000000000000000F";
const L1_FEE_IFACE = new ethers.Interface(["function getL1Fee(bytes data) view returns (uint256)"]);
const SCANNER_SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS ?? "30");
const SCANNER_GAS_BUFFER_BPS = BigInt(process.env.GAS_BUFFER_BPS ?? "20000");
const ceilDiv = (n, d) => (n + d - 1n) / d;
let scannerMinimumProfitWeth = 1n;
async function loadScannerMinimumProfit() {
  if (!cfg.ethUsdFeed || !scannerWallet || !scannerExecutor) throw new Error("Executor credentials/config unavailable for exact fee estimation");
  const feed = new ethers.Contract(cfg.ethUsdFeed, [
    "function decimals() view returns (uint8)", "function description() view returns (string)",
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"
  ], provider);
  const [decimals, description, round] = await Promise.all([feed.decimals(), feed.description(), feed.latestRoundData()]);
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (description.trim().toUpperCase() !== "ETH / USD" || answer <= 0n || updatedAt === 0n ||
      answeredInRound < roundId || now < updatedAt || now - updatedAt > BigInt(cfg.maxEthUsdPriceAgeSeconds ?? 1800))
    throw new Error("ETH/USD feed invalid or stale; refusing scanner profitability estimates");
  scannerMinimumProfitWeth = ceilDiv(BigInt(cfg.minProfitUsdCents ?? 1) * 10n ** 18n * 10n ** BigInt(decimals), answer * 100n);
}
async function estimateCandidateExecutionFees(c, amountIn, midOut, baseOut, blockTag, feeData) {
  if (!["v2","v3","v4"].includes(c.buy.type) || !["v2","v3","v4"].includes(c.sell.type))
    throw new Error("Discovery-only route has no matching executor");
  const hasV4 = c.buy.type === "v4" || c.sell.type === "v4";
  const hasV3 = c.buy.type === "v3" || c.sell.type === "v3";
  const buyFee = Number(c.buyFee?.fee ?? c.buyFee ?? 0);
  const sellFee = Number(c.sellFee?.fee ?? c.sellFee ?? 0);
  const route = {
    intermediateToken: c.midToken.address, buyRouter: c.buy.router, sellRouter: c.sell.router,
    minIntermediateOut: midOut * (10000n-SCANNER_SLIPPAGE_BPS)/10000n,
    minFinalOut: baseOut * (10000n-SCANNER_SLIPPAGE_BPS)/10000n,
    buyFee, sellFee,
    buyTickSpacing: Number(c.buyFee?.tickSpacing ?? 0),
    sellTickSpacing: Number(c.sellFee?.tickSpacing ?? 0),
    gasReserveInAsset: 1n, minProfit: scannerMinimumProfitWeth,
    deadline: BigInt(Math.floor(Date.now()/1000)+45)
  };
  const populate = r => hasV4
    ? scannerExecutor.startV4.populateTransaction(cfg.tokens.WETH.address, amountIn, r)
    : hasV3
      ? scannerExecutor.startV3.populateTransaction(cfg.tokens.WETH.address, amountIn, r)
      : scannerExecutor.start.populateTransaction(cfg.tokens.WETH.address, amountIn, r);
  const feeFields = feeData.maxFeePerGas
    ? {maxFeePerGas:feeData.maxFeePerGas,maxPriorityFeePerGas:feeData.maxPriorityFeePerGas ?? 0n}
    : {gasPrice:feeData.gasPrice};
  const gasPriceCap = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!gasPriceCap) throw new Error("Missing gas price");
  const l1 = async data => {
    const call=L1_FEE_IFACE.encodeFunctionData("getL1Fee",[data ?? "0x"]);
    const raw=await provider.call({to:L1_FEE_ORACLE,data:call},blockTag);
    return L1_FEE_IFACE.decodeFunctionResult("getL1Fee",raw)[0];
  };
  let gas=0n,l1Fee=0n,gasLimit=0n,reserve=1n,converged=false;
  for(let i=0;i<12;i++){
    const tx=await populate(route);
    [gas,l1Fee]=await Promise.all([
      provider.estimateGas({...tx,from:scannerWallet.address,...feeFields}), l1(tx.data)
    ]);
    gasLimit=ceilDiv(gas*120n,100n);
    const next=ceilDiv((gasLimit*gasPriceCap+l1Fee)*SCANNER_GAS_BUFFER_BPS,10000n);
    if(next===reserve){converged=true;break;}
    reserve=next; route.gasReserveInAsset=reserve;
  }
  if(!converged) throw new Error("Executor fee reserve did not converge");
  const finalTx=await populate(route);
  const [finalGas,finalL1]=await Promise.all([
    provider.estimateGas({...finalTx,from:scannerWallet.address,...feeFields}),l1(finalTx.data)
  ]);
  const finalLimit=ceilDiv(finalGas*120n,100n);
  const finalReserve=ceilDiv((finalLimit*gasPriceCap+finalL1)*SCANNER_GAS_BUFFER_BPS,10000n);
  if(finalReserve!==route.gasReserveInAsset) throw new Error("Final calldata fee reserve changed");
  return {gas:finalGas,gasLimit:finalLimit,l2Cost:finalLimit*gasPriceCap,l1Fee:finalL1,reserve:finalReserve,gasPriceCap};
}

// Build venue contracts against each quote endpoint; the primary provider remains
// responsible for the canonical scan block and executor-side verification.
const quoteContracts = quoteProviders.map(quoteProvider => {
  const contracts = new Map();
  for (const venue of cfg.venues) {
    if (venue.type === "v2") contracts.set(venue.name, new ethers.Contract(venue.router, V2_ABI, quoteProvider));
    if (venue.type === "v3") contracts.set(venue.name, new ethers.Contract(venue.quoter, V3_QUOTER_ABI, quoteProvider));
    if (venue.type === "v4") contracts.set(venue.name, new ethers.Contract(venue.quoter, V4_QUOTER_ABI, quoteProvider));
    if (venue.type === "v4") contracts.set(`${venue.name}:stateView`, new ethers.Contract(cfg.v4StateView, V4_STATE_VIEW_ABI, quoteProvider));
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
        token?.securityPassed === true &&
        token?.security?.passed === true &&
        token?.security?.chainId === 8453 &&
        Number.isFinite(Date.parse(token.security.checkedAt)) &&
        Date.now() - Date.parse(token.security.checkedAt) <= 10 * 60 * 1000 &&
        Number(token.liquidityUsd ?? 0) >= 1000 &&
        token?.symbol && token?.address && Number.isInteger(token.decimals) &&
        !Object.prototype.hasOwnProperty.call(cfg.tokens, token.symbol)) {
      discoveredTokens[token.symbol] = {
        address: ethers.getAddress(token.address),
        decimals: token.decimals,
        discoveryOnly: false,
        securityPassed: true,
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
  const now = Date.now();
  const eligible = Array.from({ length: quoteProviders.length }, (_, offset) => (firstProvider + offset) % quoteProviders.length)
    .filter(index => quoteEndpointCooldownUntil[index] <= now);
  quoteRetryStats.skippedCoolingEndpoints += quoteProviders.length - eligible.length;
  const providerOrder = eligible.length ? eligible : [firstProvider];
  for (let attempt = 0; attempt < providerOrder.length; attempt++) {
    const providerIndex = providerOrder[attempt];
    const endpointStats = quoteEndpointStats[providerIndex];
    const startedAt = Date.now();
    endpointStats.calls++;
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
        const poolKey = { currency0, currency1, fee: fee.fee, tickSpacing: fee.tickSpacing, hooks: ethers.ZeroAddress };
        // V4 uses a singleton PoolManager. StateView returns zero sqrtPriceX96
        // for an uninitialized pool; skip it before invoking the Quoter.
        const poolId = ethers.keccak256(V4_POOL_ID_ABI.encode(
          ["address", "address", "uint24", "int24", "address"],
          [currency0, currency1, fee.fee, fee.tickSpacing, ethers.ZeroAddress]
        ));
        const stateKey = `${providerIndex}:${poolId}:${blockTag}`;
        let statePromise = v4PoolStateCache.get(stateKey);
        if (!statePromise) {
          const stateView = quoteContracts[providerIndex].get(`${venue.name}:stateView`);
          statePromise = Promise.all([
            stateView.getSlot0(poolId, { blockTag }),
            stateView.getLiquidity(poolId, { blockTag })
          ]).then(([slot0, liquidity]) => ({ slot0, liquidity }));
          v4PoolStateCache.set(stateKey, statePromise);
          // Do not retain a rejected RPC promise; the next endpoint must be able to retry.
          statePromise.catch(() => v4PoolStateCache.delete(stateKey));
        }
        const { slot0, liquidity } = await statePromise;
        v4PreflightStats.checked++;
        if (slot0.sqrtPriceX96 === 0n) {
          v4PreflightStats.uninitialized++;
          throw new Error("V4_POOL_NOT_INITIALIZED");
        }
        // A zero active-liquidity pool cannot produce an exact-input swap at this tick.
        if (liquidity === 0n) {
          v4PreflightStats.zeroActiveLiquidity++;
          throw new Error("V4_POOL_ZERO_ACTIVE_LIQUIDITY");
        }
        v4PreflightStats.initializedWithLiquidity++;
        const params = { poolKey, zeroForOne: a < b, exactAmount: amountIn, hookData: "0x" };
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
      const elapsed = Date.now() - startedAt;
      endpointStats.successes++;
      endpointStats.consecutiveTransientFailures = 0;
      endpointStats.totalLatencyMs += elapsed;
      endpointStats.maxLatencyMs = Math.max(endpointStats.maxLatencyMs, elapsed);
      quoteEndpointCooldownUntil[providerIndex] = 0;
      venueStats.successes++;
      if (attempt > 0) quoteRetryStats.recovered++;
      return result;
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      endpointStats.failures++;
      endpointStats.totalLatencyMs += elapsed;
      endpointStats.maxLatencyMs = Math.max(endpointStats.maxLatencyMs, elapsed);
      lastError = error;
      const kind = classifyQuoteError(error);
      endpointStats.failureKinds[kind] = (endpointStats.failureKinds[kind] ?? 0) + 1;
      if (venue.type === "v4" && quoteFailureSamples.length < 16) {
        const rawData = error?.data ?? error?.info?.error?.data ?? error?.error?.data ?? null;
        quoteFailureSamples.push({
          venue: venue.name, tokenIn: tokenIn.symbol ?? tokenIn.address,
          tokenOut: tokenOut.symbol ?? tokenOut.address, fee: fee?.fee ?? fee,
          tickSpacing: fee?.tickSpacing ?? null, provider: endpointStats.endpoint,
          kind, message: String(error?.shortMessage ?? error?.reason ?? error?.message ?? error).slice(0, 240),
          revertData: typeof rawData === "string" ? rawData.slice(0, 138) : null
        });
      }
      if (kind === "rpc_transient" || kind === "rpc_rate_limited") {
        endpointStats.consecutiveTransientFailures++;
        if (endpointStats.consecutiveTransientFailures >= 3) {
          quoteEndpointCooldownUntil[providerIndex] = Date.now() + 20000;
        }
      } else {
        endpointStats.consecutiveTransientFailures = 0;
      }
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
  if (/v4_pool_not_initialized|poolnotinitialized|pool not initialized|pool does not exist|pool not found|insufficient liquidity|insufficient_output|no liquidity|zero_active_liquidity/.test(message)) return "no_pool_or_liquidity";
  // A generic eth_call revert can be endpoint-specific or have missing revert
  // data. Retry one alternate RPC before treating it as a genuine no-pool result.
  if (/call_exception|execution reverted|missing revert data/.test(message)) return "contract_revert";
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
function feeKey(fee) { return fee && typeof fee === "object" ? `${fee.fee}:${fee.tickSpacing}` : String(fee); }

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
  await loadScannerMinimumProfit();
  const v4ExecutionEnabled = process.env.EXECUTOR_V4_ENABLED === "true";
  if (v4ExecutionEnabled) {
    if (!scannerExecutor || !cfg.poolManager) throw new Error("V4 execution enabled without executor or configured PoolManager");
    const [deployedManager, managerType, managerAllowed] = await Promise.all([
      scannerExecutor.poolManager(), scannerExecutor.routerType(cfg.poolManager), scannerExecutor.approvedRouter(cfg.poolManager)
    ]);
    if (deployedManager.toLowerCase() !== cfg.poolManager.toLowerCase() || Number(managerType) !== 3 || !managerAllowed)
      throw new Error("Deployed executor is not configured for this exact V4 PoolManager");
  }
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
  const discoveryOnlyRows = [];
  const stats = {
    routeQuotesAttempted: 0, quoteFailures: 0, insufficientFlashLiquidity: 0,
    rejectedBeforeGas: 0, rejectedAfterGas: 0, profitableIndicative: 0,
    scanConcurrency: SCAN_CONCURRENCY
  };
  const tasks = [];
  const feeEstimateFailureKinds = Object.create(null);
  const feeEstimateFailureSamples = [];
  const poolProbeStats = { pairsChecked: 0, poolsFound: 0, tasksSkippedNoPool: 0, probeErrors: 0, probeErrorsAllowedToQuote: 0 };
  const routeableVenueKeys = new Set();
  const poolProbeTasks = [];
  const wethForProbe = cfg.tokens.WETH;
  const factoryCache = new Map();
  async function hasConfiguredPool(venue, token) {
    let anyExists = false;
    for (const fee of feeOptions(venue)) {
      const key = [venue.name, token.address.toLowerCase(), feeKey(fee)].join(":");
      if (routeableVenueKeys.has(key)) { anyExists = true; continue; }
      // V4 has no factory probe in this scanner; its Quoter performs the
      // authoritative no-hook/pool/liquidity validation during route quoting.
      if (venue.type === "v4") {
        routeableVenueKeys.add(key);
        anyExists = true;
        continue;
      }
      let exists = false;
      let probeFailed = false;
      try {
        let factory = factoryCache.get(venue.factory);
        if (!factory) {
          const abi = venue.type === "v3"
            ? ["function getPool(address,address,uint24) view returns (address)"]
            : venue.type === "aerodrome"
              ? ["function getPool(address,address,bool) view returns (address)"]
              : ["function getPair(address,address) view returns (address)"];
          factory = new ethers.Contract(venue.factory, abi, provider);
          factoryCache.set(venue.factory, factory);
        }
        const poolAddress = venue.type === "v3"
          ? await factory.getPool(wethForProbe.address, token.address, fee, { blockTag: block })
          : venue.type === "aerodrome"
            ? await factory.getPool(wethForProbe.address, token.address, Boolean(fee), { blockTag: block })
            : await factory.getPair(wethForProbe.address, token.address, { blockTag: block });
        exists = poolAddress !== ethers.ZeroAddress && (await provider.getCode(poolAddress, block)) !== "0x";
      } catch {
        // Do not silently discard a route because the preflight RPC failed.
        // The actual venue quote is the authoritative pool/liquidity check.
        poolProbeStats.probeErrors++;
        poolProbeStats.probeErrorsAllowedToQuote++;
        probeFailed = true;
        exists = true;
      }
      if (exists) {
        routeableVenueKeys.add(key);
        if (!probeFailed) poolProbeStats.poolsFound++;
        anyExists = true;
      }
    }
    return anyExists;
  }
  for (const [midName, midToken] of tokenEntries) {
    if (midName === "WETH" || midToken.address.toLowerCase() === wethForProbe.address.toLowerCase()) continue;
    for (const venue of scanVenues) poolProbeTasks.push({ midName, midToken, venue });
  }
  poolProbeStats.pairsChecked = poolProbeTasks.length;
  await runBounded(poolProbeTasks, Math.min(SCAN_CONCURRENCY, 6), async task => {
    await hasConfiguredPool(task.venue, task.midToken);
  });
  stats.poolProbe = poolProbeStats;
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
            const buyPoolKey = [buy.name, midToken.address.toLowerCase(), feeKey(buyFee)].join(":");
            const sellPoolKey = [sell.name, midToken.address.toLowerCase(), feeKey(sellFee)].join(":");
            if (!routeableVenueKeys.has(buyPoolKey) || !routeableVenueKeys.has(sellPoolKey)) {
              poolProbeStats.tasksSkippedNoPool++;
              continue;
            }
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
    if (baseToken.address.toLowerCase() !== cfg.wrappedNative.toLowerCase()) return;
    const v4Ready = v4ExecutionEnabled || (buy.type !== "v4" && sell.type !== "v4");
    const executorCompatible = v4Ready && ["v2", "v3", "v4"].includes(buy.type) && ["v2", "v3", "v4"].includes(sell.type);
    if (!executorCompatible) {
      discoveryOnlyRows.push({
        block, base: amounts.token, routeHops: 2, route: ["WETH", midName, "WETH"],
        intermediate: midName, intermediateAddress: midToken.address, amountIn: amountText,
        buyVenue: buy.name, buyType: buy.type, buyFee,
        sellVenue: sell.name, sellType: sell.type, sellFee,
        grossSurplusAfterFlashPremium: ethers.formatUnits(gross, baseToken.decimals),
        estimatedNetProfit: null, feeEstimateStatus: "not_estimated_executor_unsupported",
        gasAdjusted: false, l1DataFeeIncluded: false, executorCompatible: false,
        executionStatus: "discovery_only",
        note: "Positive gross surplus after flash-loan premium only. V4 remains discovery-only until EXECUTOR_V4_ENABLED=true is set for a deployed V4-capable executor; gas/L1 fees and net profit are not estimated."
      });
      return;
    }
    let feeEstimate;
    try {
      feeEstimate = await estimateCandidateExecutionFees({midToken,buy,sell,buyFee,sellFee},amountIn,midOut,baseOut,block,feeData);
    } catch (error) {
      stats.executionFeeEstimateFailures = (stats.executionFeeEstimateFailures ?? 0) + 1;
      const code = String(error?.code ?? error?.name ?? "unknown").slice(0, 48);
      feeEstimateFailureKinds[code] = (feeEstimateFailureKinds[code] ?? 0) + 1;
      if (feeEstimateFailureSamples.length < 5) {
        const message = String(error?.shortMessage ?? error?.reason ?? error?.message ?? "unknown")
          .replace(/https?:\/\/\S+/g, "[rpc-url]").replace(/0x[a-fA-F0-9]{64}/g, "[hex-data]").slice(0, 180);
        feeEstimateFailureSamples.push({ code, message, route: `${buy.name} -> ${sell.name}`, intermediate: midName, amountIn: amountText });
      }
      return;
    }
    const l2GasCostBase = feeEstimate.l2Cost;
    const l1DataFeeBase = feeEstimate.l1Fee;
    const gasCostBase = l2GasCostBase + l1DataFeeBase;
    if (gross <= feeEstimate.reserve || gross <= gasCostBase + scannerMinimumProfitWeth) {
      stats.rejectedAfterGas++;
      return;
    }
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
        estimatedL2GasCost: ethers.formatUnits(l2GasCostBase, baseToken.decimals),
        estimatedL1DataFee: ethers.formatUnits(l1DataFeeBase, baseToken.decimals),
        measuredExecutorGas: feeEstimate.gas.toString(),
        transactionGasLimitWith20PercentHeadroom: feeEstimate.gasLimit.toString(),
        bufferedGasReserve: ethers.formatUnits(feeEstimate.reserve, baseToken.decimals),
        exactExecutorCalldataL1Fee: true,
        l1DataFeeIncluded: true,
        estimatedNetProfit: ethers.formatUnits(net, baseToken.decimals),
        estimatedNetProfitRaw: net.toString(),
        gasPriceWei: feeEstimate.gasPriceCap.toString(),
        gasAdjusted: true,
        routeSpecificGasEstimate: true,
        quoteBlock: block,
        executionStatus: "requires_executor_validation",
        note: "Executor-compatible route only; not execution-ready until on-chain token/router approvals, fresh quotes, full gas accounting, and exact transaction simulation all pass."
      });
    }
  });

  // Bounded three-hop discovery: WETH -> token A -> token B -> WETH.
  // These candidates are discovery-only; the deployed executor remains two-hop.
  // Three-hop discovery must start from established configured assets, not
  // newly discovered watchlist tokens whose reported USD liquidity does not
  // prove that a pool exists on any of our configured venues. The two-hop scan
  // still evaluates all discovered tokens independently.
  const tripleTokens = Object.entries(cfg.tokens)
    .filter(([name, token]) => name !== "WETH" && token.address.toLowerCase() !== cfg.tokens.WETH.address.toLowerCase())
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
  stats.threeHopTokenSymbols = tripleTokens.map(([name]) => name);
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
    stats.threeHopGrossPositive = (stats.threeHopGrossPositive ?? 0) + 1;
    discoveryOnlyRows.push({
      block, base: "WETH", routeHops: 3,
      route: ["WETH", firstName, secondName, "WETH"],
      intermediates: [
        { symbol: firstName, address: firstToken.address, decimals: firstToken.decimals },
        { symbol: secondName, address: secondToken.address, decimals: secondToken.decimals }
      ],
      amountIn: amountText,
      venues: [firstVenue.name, secondVenue.name, thirdVenue.name],
      fees: [firstFee, secondFee, thirdFee],
      grossSurplusAfterFlashPremium: ethers.formatUnits(gross, 18),
      estimatedNetProfit: null,
      feeEstimateStatus: "not_estimated_executor_unsupported",
      gasAdjusted: false,
      l1DataFeeIncluded: false,
      executorCompatible: false,
      executionStatus: "discovery_only",
      note: "Three-hop route has positive gross surplus after flash-loan premium, but no net-profit estimate: current executor does not support three-hop execution."
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
    stats: { ...stats, feeEstimateFailureKinds, feeEstimateFailureSamples,
      quoteFailureKinds, quoteVenueStats, quoteRetryStats, quoteEndpointStats,
      v4PreflightStats, quoteFailureSamples, quoteRpcEndpoints: quoteProviders.length },
    candidates: rows,
    discoveryOnlyCandidates: discoveryOnlyRows
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
  const discoveryOnlyCount = discoveryOnlyRows.length;
  console.log(`Candidate status: ${executorCompatibleCount} executor-compatible pending validation; ${discoveryOnlyCount} discovery-only (unsupported venue combinations or three-hop routes).`);
  for (const r of rows.slice(0, 20)) console.log(r.routeHops === 3 ? (r.route.join(" -> ") + " | " + r.amountIn + " WETH | net=" + r.estimatedNetProfit + " (discovery-only)") : (r.base + " " + r.amountIn + " | " + r.buyVenue + " -> " + r.sellVenue + " | net=" + r.estimatedNetProfit));
  console.log("Scan diagnostics:", JSON.stringify({ ...stats, feeEstimateFailureKinds, feeEstimateFailureSamples,
    quoteFailureKinds, quoteVenueStats, quoteRetryStats, quoteEndpointStats,
    v4PreflightStats, quoteFailureSamples, quoteRpcEndpoints: quoteProviders.length }));
  if (!rows.length) console.log("No executor-compatible candidates passed Aave premium, estimated L2 + L1 fees, and minimum-profit filters.");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
