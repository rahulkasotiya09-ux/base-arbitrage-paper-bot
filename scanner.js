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
const erc20Abi = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

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
    });
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
  if (Number(network.chainId) !== cfg.chainId) throw new Error(`RPC chain mismatch: expected ${cfg.chainId}, got ${network.chainId}`);
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
              const premium = amountIn * BigInt(cfg.flashLoanPremiumBps) / 10000n;
              const gross = baseOut - amountIn - premium;
              let gasCostBase = null;
              let net = gross;
              const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
              if (baseToken.address.toLowerCase() === cfg.wrappedNative.toLowerCase() && gasPrice) {
                gasCostBase = BigInt(cfg.gasLimitEstimate) * gasPrice;
                net = gross - gasCostBase;
              }
              if (net >= BigInt(cfg.minProfitBaseUnits)) {
                rows.push({
                  block, base: amounts.token, intermediate: midName, amountIn: amountText,
                  buyVenue: buy.name, buyFee, sellVenue: sell.name, sellFee,
                  intermediateOut: ethers.formatUnits(midOut, midToken.decimals),
                  finalOut: ethers.formatUnits(baseOut, baseToken.decimals),
                  flashPremium: ethers.formatUnits(premium, baseToken.decimals),
                  grossProfit: ethers.formatUnits(gross, baseToken.decimals),
                  estimatedGasCost: gasCostBase === null ? "NOT CONVERTED - exclude from decision" : ethers.formatUnits(gasCostBase, baseToken.decimals),
                  estimatedNetProfit: gasCostBase === null ? "NOT COMPUTED - gas asset differs from borrowed asset" : ethers.formatUnits(net, baseToken.decimals),
                  gasPriceWei: gasPrice?.toString() ?? null,
                  gasAdjusted: true,\n                  quoteBlock: block,\n                  note: "Indicative same-block quotes only; re-simulate immediately before execution. Gas estimate is conservative input, not actual receipt gas."
                });
              }
            }
          }
        }
      }
    }
  }
  rows.sort((a,b) => {
    if (a.estimatedNetProfit.startsWith("NOT")) return 1;
    if (b.estimatedNetProfit.startsWith("NOT")) return -1;
    return Number(b.estimatedNetProfit) - Number(a.estimatedNetProfit);
  });
  const output = {chainId: cfg.chainId, block, checkedAt: new Date().toISOString(), candidates: rows};
  fs.writeFileSync("opportunities.json", JSON.stringify(output, null, 2));
  if (rows.length) {
    const top = rows.slice(0, 5).map(r =>
      `${r.base} ${r.amountIn} | ${r.buyVenue} -> ${r.sellVenue} | estimated net: ${r.estimatedNetProfit}`
    ).join("\\n");
    await notifyTelegram(`FlashArb scanner: ${rows.length} candidate(s) at block ${block}\\n\\n${top}\\n\\nQuotes are indicative only. NOT EXECUTABLE / NOT GUARANTEED.`);
  }
  console.log(`Scanned block ${block}. ${rows.length} candidate(s) written to opportunities.json`);
  for (const r of rows.slice(0, 20)) console.log(`${r.base} ${r.amountIn} | ${r.buyVenue} -> ${r.sellVenue} | net=${r.estimatedNetProfit}`);
  if (!rows.length) console.log("No candidates passed configured thresholds. This is normal.");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
