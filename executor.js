import "dotenv/config";
import fs from "node:fs";
import { ethers } from "ethers";

const cfg = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const required = ["RPC_URL", "EXECUTOR_ADDRESS", "WALLET_PRIVATE_KEY"];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key} in .env`);

const LIVE = process.env.LIVE_TRADING === "true";
if (LIVE && process.env.CONFIRM_LIVE_TRADING !== "I_ACCEPT_TRANSACTION_RISK") {
  throw new Error("Live mode requires CONFIRM_LIVE_TRADING=I_ACCEPT_TRANSACTION_RISK");
}
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, cfg.chainId);
const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
const abi = [
  "function owner() view returns (address)",
  "function start(address asset,uint256 amount,(address intermediateToken,address buyRouter,address sellRouter,uint256 minIntermediateOut,uint256 minFinalOut,uint256 gasCostInAsset,uint256 minProfit,uint256 deadline) route)"
];
const executor = new ethers.Contract(process.env.EXECUTOR_ADDRESS, abi, wallet);

const slippageBps = BigInt(process.env.SLIPPAGE_BPS ?? "30");
const gasBufferBps = BigInt(process.env.GAS_BUFFER_BPS ?? "12000");
const minProfit = BigInt(process.env.MIN_PROFIT_BASE_UNITS ?? cfg.minProfitBaseUnits);

function minAfterSlippage(amount) {
  return amount * (10000n - slippageBps) / 10000n;
}

async function main() {
  if (Number((await provider.getNetwork()).chainId) !== cfg.chainId) throw new Error("RPC chain mismatch");
  if (slippageBps < 1n || slippageBps > 500n) throw new Error("SLIPPAGE_BPS must be between 1 and 500");
  if (gasBufferBps < 10000n || gasBufferBps > 20000n) throw new Error("GAS_BUFFER_BPS must be 10000..20000");

  const owner = await executor.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("Wallet is not the executor contract owner");

  const output = JSON.parse(fs.readFileSync(new URL("./opportunities.json", import.meta.url), "utf8"));
  if (output.chainId !== cfg.chainId) throw new Error("Opportunity file chain mismatch");
  const currentBlock = await provider.getBlockNumber();
  const quoteBlock = Number(output.block);
  const maxQuoteAge = Number(cfg.maxQuoteAgeBlocks ?? 2);
  if (!Number.isSafeInteger(quoteBlock) || currentBlock - quoteBlock < 0 || currentBlock - quoteBlock > maxQuoteAge) {
    throw new Error(`Stale or invalid quote: quoted at block ${output.block}, current block ${currentBlock}`);
  }
  const candidate = output.candidates.find(x =>
    x.base === "WETH" && x.executorCompatible === true &&
    x.buyRouter && x.sellRouter && x.intermediateOutRaw && x.finalOutRaw
  );
  if (!candidate) throw new Error("No V2-only WETH candidate. Scanner quotes are not a promise of profit.");

  const base = cfg.tokens.WETH;
  const mid = cfg.tokens[candidate.intermediate];
  if (!mid) throw new Error("Unknown intermediate token in candidate");
  const asset = ethers.getAddress(base.address);
  const intermediateToken = ethers.getAddress(mid.address);
  const buyRouter = ethers.getAddress(candidate.buyRouter);
  const sellRouter = ethers.getAddress(candidate.sellRouter);
  const amount = ethers.parseUnits(candidate.amountIn, base.decimals);
  const quotedMid = BigInt(candidate.intermediateOutRaw);
  const quotedFinal = BigInt(candidate.finalOutRaw);
  const minIntermediateOut = minAfterSlippage(quotedMid);
  const minFinalOut = minAfterSlippage(quotedFinal);
  const feeData = await provider.getFeeData();
  const feeFields = feeData.maxFeePerGas
    ? { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n }
    : { gasPrice: feeData.gasPrice };
  const effectiveCap = feeFields.maxFeePerGas ?? feeFields.gasPrice;
  if (!effectiveCap) throw new Error("RPC did not return usable gas pricing");

  const deadline = Math.floor(Date.now() / 1000) + 45;
  const route = {
    intermediateToken, buyRouter, sellRouter,
    minIntermediateOut, minFinalOut,
    gasCostInAsset: 0n, minProfit, deadline
  };
  const txRequest = async (r) => executor.start.populateTransaction(asset, amount, r);
  let tx = await txRequest(route);
  const baseTx = { ...tx, from: wallet.address, ...feeFields };
  // First estimate the full flashloan+swap transaction, then reserve gas in WETH.
  const gasEstimate = await provider.estimateGas(baseTx);
  const gasReserve = gasEstimate * effectiveCap * gasBufferBps / 10000n;
  route.gasCostInAsset = gasReserve;
  tx = await txRequest(route);
  const exactTx = { ...tx, from: wallet.address, gasLimit: gasEstimate, ...feeFields };

  // eth_call executes the complete transaction in a temporary state; no transaction is sent.
  await provider.call(exactTx);
  console.log(JSON.stringify({
    mode: LIVE ? "LIVE (explicitly enabled)" : "SIMULATION ONLY",
    candidate: { base: candidate.base, intermediate: candidate.intermediate, amountIn: candidate.amountIn,
      buy: candidate.buyVenue, sell: candidate.sellVenue, quoteBlock: candidate.quoteBlock },
    estimatedGas: gasEstimate.toString(),
    gasReserveWeth: ethers.formatUnits(gasReserve, 18),
    minimumProfitWeth: ethers.formatUnits(minProfit, 18),
    simulated: true
  }, null, 2));

  if (!LIVE) {
    console.log("Simulation succeeded. No transaction was broadcast. Set LIVE_TRADING=true only after independent review.");
    return;
  }

  const response = await wallet.sendTransaction({ ...tx, gasLimit: gasEstimate, ...feeFields });
  console.log("Broadcast transaction:", response.hash);
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Transaction failed or was reverted");
  const actualGasWei = receipt.gasUsed * (receipt.gasPrice ?? effectiveCap);
  console.log(JSON.stringify({
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    actualGasCostEth: ethers.formatEther(actualGasWei),
    note: "Inspect the ArbitrageCompleted event and wallet balance changes to confirm realized token profit."
  }, null, 2));
}

main().catch(err => {
  console.error("Executor stopped:", err.shortMessage ?? err.message);
  process.exitCode = 1;
});
