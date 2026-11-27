import "dotenv/config";
import fs from "node:fs";
import { ethers } from "ethers";

const cfg = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));
for (const key of ["RPC_URL", "EXECUTOR_ADDRESS", "WALLET_PRIVATE_KEY"]) {
  if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
}
const LIVE = process.env.LIVE_TRADING === "true";
if (LIVE && process.env.CONFIRM_LIVE_TRADING !== "I_ACCEPT_TRANSACTION_RISK") {
  throw new Error("Live mode requires explicit risk confirmation");
}
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, cfg.chainId);
const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
const executor = new ethers.Contract(process.env.EXECUTOR_ADDRESS, [
  "function owner() view returns (address)",
  "function start(address asset,uint256 amount,(address intermediateToken,address buyRouter,address sellRouter,uint256 minIntermediateOut,uint256 minFinalOut,uint256 gasCostInAsset,uint256 minProfit,uint256 deadline) route)"
], wallet);
const routerAbi = ["function factory() view returns (address)"];
const l1Oracle = "0x420000000000000000000000000000000000000F";
const l1Iface = new ethers.Interface(["function getL1Fee(bytes data) view returns (uint256)"]);
const priceFeedAbi = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)"
];
const slip = BigInt(process.env.SLIPPAGE_BPS ?? "30");
const buffer = BigInt(process.env.GAS_BUFFER_BPS ?? "20000");
const minProfitUsdCents = BigInt(cfg.minProfitUsdCents ?? 1);
const minOut = x => x * (10000n - slip) / 10000n;
const ceilDiv = (n, d) => (n + d - 1n) / d;

async function getL1Fee(data) {
  const callData = l1Iface.encodeFunctionData("getL1Fee", [data ?? "0x"]);
  const raw = await provider.call({ to: l1Oracle, data: callData });
  return l1Iface.decodeFunctionResult("getL1Fee", raw)[0];
}

async function getMinimumProfitWeth() {
  if (!Number.isSafeInteger(Number(minProfitUsdCents)) || minProfitUsdCents < 1n) {
    throw new Error("Minimum profit must be at least one USD cent");
  }
  const feedAddress = ethers.getAddress(cfg.ethUsdFeed);
  const feed = new ethers.Contract(feedAddress, priceFeedAbi, provider);
  const [decimals, round] = await Promise.all([feed.decimals(), feed.latestRoundData()]);
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (answer <= 0n || updatedAt === 0n || answeredInRound < roundId ||
      now < updatedAt || now - updatedAt > BigInt(cfg.maxEthUsdPriceAgeSeconds ?? 1800)) {
    throw new Error("ETH/USD price feed is invalid or stale; refusing execution");
  }
  const scale = 10n ** BigInt(decimals);
  // Convert the configured USD-cent floor to WETH wei, rounding upward.
  const minimumWethWei = ceilDiv(minProfitUsdCents * 10n ** 18n * scale, 100n * answer);
  return { minimumWethWei, ethUsdAnswer: answer.toString(), feedDecimals: Number(decimals), updatedAt: updatedAt.toString() };
}

async function main() {
  if (cfg.chainId !== 8453 || Number((await provider.getNetwork()).chainId) !== 8453) {
    throw new Error("Executor is restricted to Base Mainnet (chain 8453)");
  }
  if (slip < 1n || slip > 500n || buffer < 10000n || buffer > 30000n) {
    throw new Error("Unsafe slippage or gas-buffer setting");
  }
  if ((await executor.owner()).toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error("Wallet is not contract owner");
  }

  const output = JSON.parse(fs.readFileSync(new URL("./opportunities.json", import.meta.url), "utf8"));
  const block = await provider.getBlockNumber();
  const quoteBlock = Number(output.block);
  if (output.chainId !== 8453 || !Number.isSafeInteger(quoteBlock) ||
      block < quoteBlock || block - quoteBlock > Number(cfg.maxQuoteAgeBlocks ?? 1)) {
    throw new Error("Opportunity quotes are stale or from the wrong chain");
  }
  const c = output.candidates.find(x => x.base === "WETH" && x.executorCompatible &&
    x.buyRouter && x.sellRouter && x.intermediateOutRaw && x.finalOutRaw);
  if (!c) throw new Error("No V2/V2 WETH opportunity passed scanner filters");

  const base = cfg.tokens.WETH, mid = cfg.tokens[c.intermediate];
  if (!mid) throw new Error("Unknown intermediate token");
  const asset = ethers.getAddress(base.address), intermediate = ethers.getAddress(mid.address);
  const buy = ethers.getAddress(c.buyRouter), sell = ethers.getAddress(c.sellRouter);
  for (const [addr, venue] of [[buy, cfg.venues.find(v => v.router?.toLowerCase() === buy.toLowerCase())],
                                [sell, cfg.venues.find(v => v.router?.toLowerCase() === sell.toLowerCase())]]) {
    if (!venue?.factory || venue.type !== "v2") throw new Error("Router is not in the approved V2 configuration");
    const [code, factory] = await Promise.all([
      provider.getCode(addr), new ethers.Contract(addr, routerAbi, provider).factory()
    ]);
    if (code === "0x" || factory.toLowerCase() !== venue.factory.toLowerCase()) {
      throw new Error("Router code/factory verification failed");
    }
  }
  for (const token of [asset, intermediate]) {
    if (await provider.getCode(token) === "0x") throw new Error("Token contract missing");
  }

  const amount = ethers.parseUnits(c.amountIn, base.decimals);
  const fee = await provider.getFeeData();
  const feeFields = fee.maxFeePerGas
    ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n }
    : { gasPrice: fee.gasPrice };
  const cap = feeFields.maxFeePerGas ?? feeFields.gasPrice;
  if (!cap) throw new Error("No gas price available");

  const price = await getMinimumProfitWeth();
  const deadline = Math.floor(Date.now() / 1000) + 45;
  // First estimate the execution path with zero reserve/floor. This estimate is
  // never used as approval to trade; the final call below must pass with all costs.
  const route = {
    intermediateToken: intermediate, buyRouter: buy, sellRouter: sell,
    minIntermediateOut: minOut(BigInt(c.intermediateOutRaw)),
    minFinalOut: minOut(BigInt(c.finalOutRaw)),
    gasCostInAsset: 0n, minProfit: 0n, deadline
  };
  const populate = r => executor.start.populateTransaction(asset, amount, r);
  let tx = await populate(route);
  const gas = await provider.estimateGas({ ...tx, from: wallet.address, ...feeFields });
  const l2Cost = gas * cap;

  // L1 fee depends on calldata, and calldata contains gasCostInAsset. Iterate
  // until the reserve and the fee for that final calldata agree; fail closed.
  let l1Fee = await getL1Fee(tx.data ?? "0x");
  let reserve = 0n;
  let converged = false;
  for (let i = 0; i < 8; i++) {
    const nextReserve = ceilDiv((l2Cost + l1Fee) * buffer, 10000n);
    route.gasCostInAsset = nextReserve;
    route.minProfit = price.minimumWethWei;
    tx = await populate(route);
    const measuredL1Fee = await getL1Fee(tx.data ?? "0x");
    const verifiedReserve = ceilDiv((l2Cost + measuredL1Fee) * buffer, 10000n);
    if (verifiedReserve === nextReserve) {
      l1Fee = measuredL1Fee;
      reserve = nextReserve;
      converged = true;
      break;
    }
    l1Fee = measuredL1Fee;
    reserve = nextReserve;
  }
  if (!converged) throw new Error("L1 fee reserve did not converge for final calldata; refusing execution");

  const walletBalance = await provider.getBalance(wallet.address);
  if (walletBalance < reserve) {
    throw new Error(`Wallet ETH balance ${ethers.formatEther(walletBalance)} is below the buffered gas reserve ${ethers.formatEther(reserve)}`);
  }
  const exactTx = { ...tx, from: wallet.address, gasLimit: gas, ...feeFields };
  // This exact simulation enforces: principal + Aave premium + buffered L1/L2
  // gas reserve + at least $0.01 (converted using a fresh ETH/USD oracle).
  await provider.call(exactTx);

  const report = {
    mode: LIVE ? "LIVE — only if explicitly enabled" : "SIMULATION ONLY",
    candidate: { amount: c.amountIn, intermediate: c.intermediate, buy: c.buyVenue, sell: c.sellVenue, quoteBlock },
    minimumNetProfitUsd: `0.${minProfitUsdCents.toString().padStart(2, "0")}`,
    minimumNetProfitWeth: ethers.formatEther(price.minimumWethWei),
    ethUsdAnswer: price.ethUsdAnswer,
    ethUsdFeedUpdatedAt: price.updatedAt,
    estimatedGas: gas.toString(),
    maxL2GasCostWei: l2Cost.toString(),
    finalCalldataL1FeeWei: l1Fee.toString(),
    gasReserveBufferBps: buffer.toString(),
    bufferedGasReserveWeth: ethers.formatEther(reserve),
    walletEthBalance: ethers.formatEther(walletBalance),
    exactFinalTransactionSimulation: "PASSED",
    noUnaccountedProtocolFeeKnown: true
  };
  console.log(JSON.stringify(report, null, 2));
  if (!LIVE) {
    console.log("Simulation only; no transaction sent.");
    return;
  }

  const response = await wallet.sendTransaction({ ...tx, gasLimit: gas, ...feeFields });
  console.log("Broadcast transaction:", response.hash);
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");
  const actualL2 = receipt.gasUsed * (receipt.gasPrice ?? cap);
  console.log(JSON.stringify({
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    actualL2GasCostWei: actualL2.toString(),
    receiptL1FeeWei: receipt.l1Fee?.toString() ?? null,
    receiptL1GasUsed: receipt.l1GasUsed?.toString() ?? null,
    receiptL1GasPrice: receipt.l1GasPrice?.toString() ?? null,
    note: "The contract enforced the buffered gas reserve and USD-cent profit floor before repayment. Verify the receipt's L1 fee fields and ArbitrageCompleted event before withdrawing."
  }, null, 2));
}
main().catch(e => {
  console.error("Executor stopped:", e.shortMessage ?? e.message);
  process.exitCode = 1;
});
