import "dotenv/config";
import fs from "node:fs";
import { ethers } from "ethers";

// Scanner is advisory only; executor independently re-quotes before any simulation.
const cfg = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const rpc = process.env.RPC_URL;
if (!rpc) throw new Error("Set RPC_URL in .env (use a trusted Ethereum RPC endpoint).");

const provider = new ethers.JsonRpcProvider(rpc, cfg.chainId);
const V2_ABI = ["function getAmountsOut(uint amountIn,address[] calldata path) view returns (uint[] memory amounts)"];
const V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)"
];
const AAVE_PROVIDER_ABI = ["function getPool() view returns (address)"];
const AAVE_POOL_ABI = ["function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)"];
const AAVE_RESERVE_ABI = ["function balanceOf(address) view returns (uint256)"];
const AAVE_PROVIDER = cfg.aaveAddressesProvider;

const v2 = new Map();
const v3 = new Map();
for (const venue of cfg.venues) {
  if (venue.type === "v2") v2.set(venue.name, new ethers.Contract(venue.router, V2_ABI, provider));
  if (venue.type === "v3") v3.set(venue.name, new ethers.Contract(venue.quoter, V3_QUOTER_ABI, provider));
}
const discoveredPath = new URL("./new-token-watchlist.json", import.meta.url);
let discoveredTokens = {};
try {
  const watchlist = JSON.parse(fs.readFileSync(discoveredPath, "utf8"));
  for (const token of (watchlist.tokens ?? []).slice().sort((a, b) => Number(b.liquidityUsd ?? 0) - Number(a.liquidityUsd ?? 0)).slice(0, 50)) {
    if (token?.safetyPassed === true && token?.safetyProvider === "GoPlus Token Security API" &&
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

async function quote(venue, tokenIn, tokenOut, amountIn, fee, blockTag) {
  try {
    if (venue.type === "v2") {
      const amounts = await v2.get(venue.name).getAmountsOut(amountIn, [tokenIn.address, tokenOut.address], { blockTag });
      return amounts[1];
    }
    const q = await v3.get(venue.name).quoteExactInputSingle.staticCall({
      tokenIn: tokenIn.address, tokenOut: tokenOut.address,
      amountIn, fee, sqrtPriceLimitX96: 0
    }, { blockTag });
    return q.amountOut ?? q[0];
  } catch {
    return null;
  }
}

const quoteCache = new Map();
function cachedQuote(venue, tokenIn, tokenOut, amountIn, fee, blockTag) {
  const key = [venue.name, tokenIn.address.toLowerCase(), tokenOut.address.toLowerCase(),
    amountIn.toString(), fee, blockTag].join(":");
  if (!quoteCache.has(key)) quoteCache.set(key, quote(venue, tokenIn, tokenOut, amountIn, fee, blockTag));
  return quoteCache.get(key);
}
const SCAN_CONCURRENCY = 8;
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
  // Live executor currently supports V2/V2 routes only. Skip V3 quote combinations
  // that cannot be broadcast by this executor, so scan time is spent on executable paths.
  const scanVenues = cfg.venues.filter(venue => venue.type === "v2" || venue.type === "v3");
  if (scanVenues.length < 2) throw new Error("At least two configured V2 venues are required for executable arbitrage scanning");
  const rows = [];
  const stats = {
    routeQuotesAttempted: 0, quoteFailures: 0, insufficientFlashLiquidity: 0,
    rejectedBeforeGas: 0, rejectedAfterGas: 0, profitableIndicative: 0
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
    const gasCostBase = BigInt(cfg.gasLimitEstimate) * gasPrice;
    if (gross <= gasCostBase) { stats.rejectedAfterGas++; return; }
    const net = gross - gasCostBase;
    if (net > 0n) {
      stats.profitableIndicative++;
      rows.push({
        block, base: amounts.token, intermediate: midName, newlyDiscovered: Boolean(midToken.discoveryOnly), amountIn: amountText,
        buyVenue: buy.name, buyFee, sellVenue: sell.name, sellFee,
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
    stats, candidates: rows
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
  console.log("Scan diagnostics:", JSON.stringify(stats));
  if (!rows.length) console.log("No candidates had positive indicative profit after Aave premium and estimated L2 gas. Final L1 fee and safety buffer are checked by executor.");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
