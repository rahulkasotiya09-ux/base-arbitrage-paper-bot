import "dotenv/config";
import fs from "node:fs";
import { ethers } from "ethers";

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
const AAVE_PROVIDER = cfg.aaveAddressesProvider;

const v2 = new Map();
const v3 = new Map();
for (const venue of cfg.venues) {
  if (venue.type === "v2") v2.set(venue.name, new ethers.Contract(venue.router, V2_ABI, provider));
  if (venue.type === "v3") v3.set(venue.name, new ethers.Contract(venue.quoter, V3_QUOTER_ABI, provider));
}
const tokenEntries = Object.entries(cfg.tokens);
const fmt = (n, d) => Number(ethers.formatUnits(n, d));
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
    return null; // no pool, insufficient liquidity, or unsupported fee tier
  }
}

function feeOptions(v) { return v.type === "v3" ? v.fees : [0]; }


async function notifyTelegram(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({chat_id: chatId, text, disable_web_page_preview: true})
    });
    if (!res.ok) console.error("Telegram alert failed:", await res.text());
  } catch (err) { console.error("Telegram alert error:", err.message); }
}

async function main() {
  const [network, block, feeData] = await Promise.all([
    provider.getNetwork(), provider.getBlockNumber(), provider.getFeeData()
  ]);
  if (Number(network.chainId) !== cfg.chainId) throw new Error(`RPC chain mismatch: expected ${cfg.chainId}, got ${network.chainId}`);\n  for (const venue of cfg.venues) {\n    const target = venue.type === "v2" ? venue.router : venue.quoter;\n    if (!target || (await provider.getCode(target, block)) === "0x") throw new Error(`Configured ${venue.name} contract has no code at ${target}`);\n  }
  const poolProvider = new ethers.Contract(AAVE_PROVIDER, AAVE_PROVIDER_ABI, provider);
  const poolAddress = await poolProvider.getPool({ blockTag: block });
  const pool = new ethers.Contract(poolAddress, AAVE_POOL_ABI, provider);
  const premiumBps = BigInt(await pool.FLASHLOAN_PREMIUM_TOTAL({ blockTag: block }));
  const rows = [];
  for (const [baseName, amounts] of cfg.scanAmounts.entries()) {
    const baseToken = cfg.tokens[amounts.token];
    if (!baseToken) continue;
    for (const [midName, midToken] of tokenEntries) {
      if (midName === amounts.token || midToken.address.toLowerCase() === baseToken.address.toLowerCase()) continue;
      for (const amountText of amounts.amounts) {
        const amountIn = parse(amountText, baseToken.decimals);
        for (const buy of cfg.venues) for (const sell of cfg.venues) {
          if (buy.name === sell.name) continue;
          for (const buyFee of feeOptions(buy)) {
            const midOut = await quote(buy, baseToken, midToken, amountIn, buyFee, block);
            if (midOut === null || midOut === 0n) continue;
            for (const sellFee of feeOptions(sell)) {
              const baseOut = await quote(sell, midToken, baseToken, midOut, sellFee, block);
              if (baseOut === null) continue;
              const premium = amountIn * premiumBps / 10000n;
              const gross = baseOut - amountIn - premium;
              const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
              // ETH gas is directly denominated in the borrowed asset only for WETH routes.
              // Exclude other borrowed assets until a reliable gas-to-token conversion is implemented.
              if (baseToken.address.toLowerCase() !== cfg.wrappedNative.toLowerCase() || !gasPrice) continue;
              const gasCostBase = BigInt(cfg.gasLimitEstimate) * gasPrice;
              const net = gross - gasCostBase;
              if (net >= BigInt(cfg.minProfitBaseUnits)) {
                rows.push({
                  block, base: amounts.token, intermediate: midName, amountIn: amountText,
                  buyVenue: buy.name, buyFee, sellVenue: sell.name, sellFee,
                  buyRouter: buy.type === "v2" ? buy.router : null,
                  sellRouter: sell.type === "v2" ? sell.router : null,
                  executorCompatible: buy.type === "v2" && sell.type === "v2",
                  intermediateOut: ethers.formatUnits(midOut, midToken.decimals),
                  intermediateOutRaw: midOut.toString(),
                  finalOut: ethers.formatUnits(baseOut, baseToken.decimals),
                  finalOutRaw: baseOut.toString(),
                  flashPremium: ethers.formatUnits(premium, baseToken.decimals),
                  flashLoanPremiumBps: premiumBps.toString(),
                  grossProfit: ethers.formatUnits(gross, baseToken.decimals),
                  estimatedGasCost: gasCostBase === null ? "NOT CONVERTED - exclude from decision" : ethers.formatUnits(gasCostBase, baseToken.decimals),
                  estimatedNetProfit: gasCostBase === null ? "NOT COMPUTED - gas asset differs from borrowed asset" : ethers.formatUnits(net, baseToken.decimals),
                  gasPriceWei: gasPrice?.toString() ?? null,
                  gasAdjusted: true,
                  quoteBlock: block,
                  l1DataFeeIncluded: false,\n                  executionReady: buy.type === "v2" && sell.type === "v2",\n                  note: "Indicative same-block quotes only. Estimated gas covers L2 execution only; Base L1 data fee is NOT included. Re-quote, calculate L1 fee from final calldata, and simulate before any execution."
                });
              }
            }
          }
        }
      }
    }
  }
  rows.sort((a,b) => {
    const av = ethers.parseUnits(a.estimatedNetProfit, cfg.tokens[a.base].decimals);
    const bv = ethers.parseUnits(b.estimatedNetProfit, cfg.tokens[b.base].decimals);
    return av === bv ? 0 : (av > bv ? -1 : 1);
  });
  const output = {chainId: cfg.chainId, block, checkedAt: new Date().toISOString(), candidates: rows};
  fs.writeFileSync("opportunities.json", JSON.stringify(output, null, 2));
  if (rows.length) {
    const top = rows.slice(0, 5).map(r =>
      `${r.base} ${r.amountIn} | ${r.buyVenue} -> ${r.sellVenue} | estimated net: ${r.estimatedNetProfit}`
    ).join("\n");
    await notifyTelegram(`FlashArb scanner: ${rows.length} candidate(s) at block ${block}\n\n${top}\n\nQuotes are indicative only. NOT EXECUTABLE / NOT GUARANTEED.`);
  }
  console.log(`Scanned block ${block}. ${rows.length} preliminary candidate(s) written to opportunities.json`);\n  if (rows.some(r => !r.executionReady)) console.log("Some routes use V3 quotes and are research-only; the current executor supports V2 routes only.");
  for (const r of rows.slice(0, 20)) console.log(`${r.base} ${r.amountIn} | ${r.buyVenue} -> ${r.sellVenue} | net=${r.estimatedNetProfit}`);
  if (!rows.length) console.log("No candidates passed configured thresholds. This is normal.");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
