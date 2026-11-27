import "dotenv/config";
import fs from "node:fs";
import { ethers } from "ethers";

const cfg = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));
for (const key of ["RPC_URL", "EXECUTOR_ADDRESS", "EXECUTOR_CODE_HASH", "WALLET_PRIVATE_KEY"]) {
  if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
}
const LIVE = process.env.LIVE_TRADING === "true";
const BROADCAST_FLAG = process.argv.includes("--broadcast");
if (LIVE && (!BROADCAST_FLAG || process.env.CONFIRM_LIVE_TRADING !== "I_ACCEPT_TRANSACTION_RISK")) {
  throw new Error("Broadcast blocked: live mode requires LIVE_TRADING=true, the --broadcast CLI flag, and explicit risk confirmation.");
}
if (!LIVE && BROADCAST_FLAG) {
  throw new Error("Broadcast flag supplied but LIVE_TRADING is not true; refusing to send.");
}
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, cfg.chainId);
const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
const executor = new ethers.Contract(ethers.getAddress(process.env.EXECUTOR_ADDRESS), [
  "function owner() view returns (address)",
  "function pool() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function routerFactory(address) view returns (address)",
  "function approvedToken(address) view returns (bool)",
  "function approvedRouter(address) view returns (bool)",
  "event ArbitrageCompleted(address indexed asset,address indexed intermediateToken,uint256 principal,uint256 premium,uint256 grossProfit)",
  "function start(address asset,uint256 amount,(address intermediateToken,address buyRouter,address sellRouter,uint256 minIntermediateOut,uint256 minFinalOut,uint256 gasReserveInAsset,uint256 minProfit,uint256 deadline) route)"
], wallet);
const routerAbi = [
  "function factory() view returns (address)",
  "function getAmountsOut(uint256 amountIn,address[] calldata path) view returns (uint256[] memory amounts)"
];
const l1Oracle = "0x420000000000000000000000000000000000000F";
const l1Iface = new ethers.Interface(["function getL1Fee(bytes data) view returns (uint256)"]);
const priceFeedAbi = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
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
  const [decimals, description, round] = await Promise.all([
    feed.decimals(), feed.description(), feed.latestRoundData()
  ]);
  if (description.trim().toUpperCase() !== "ETH / USD") {
    throw new Error(`Unexpected Chainlink feed description: ${description}`);
  }
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
  const executorCode = await provider.getCode(await executor.getAddress());
  if (executorCode === "0x") throw new Error("EXECUTOR_ADDRESS has no deployed contract code");
  if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.EXECUTOR_CODE_HASH)) {
    throw new Error("EXECUTOR_CODE_HASH must be the expected 32-byte runtime code hash");
  }
  const actualCodeHash = ethers.keccak256(executorCode);
  if (actualCodeHash.toLowerCase() !== process.env.EXECUTOR_CODE_HASH.toLowerCase()) {
    throw new Error("Deployed executor bytecode hash does not match the approved code hash");
  }
  if ((await executor.owner()).toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error("Wallet is not contract owner");
  }
  if ((await executor.wrappedNative()).toLowerCase() !== cfg.wrappedNative.toLowerCase()) {
    throw new Error("Deployed contract gas-reserve asset is not the configured WETH");
  }

  const output = JSON.parse(fs.readFileSync(new URL("./opportunities.json", import.meta.url), "utf8"));
  const block = await provider.getBlockNumber();
  const quoteBlock = Number(output.block);
  if (output.chainId !== 8453 || !Number.isSafeInteger(quoteBlock) ||
      block < quoteBlock || block - quoteBlock > Number(cfg.maxQuoteAgeBlocks ?? 1)) {
    throw new Error("Opportunity quotes are stale or from the wrong chain");
  }
  const compatible = (output.candidates ?? []).filter(x =>
    x.base === "WETH" && x.executorCompatible && x.buyRouter && x.sellRouter && x.intermediate &&
    x.estimatedNetProfitRaw && /^\\d+$/.test(String(x.estimatedNetProfitRaw))
  );
  compatible.sort((a, b) => {
    const av = BigInt(a.estimatedNetProfitRaw);
    const bv = BigInt(b.estimatedNetProfitRaw);
    return av === bv ? 0 : (av > bv ? -1 : 1);
  });
  const c = compatible[0];
  if (!c) throw new Error("No V2/V2 WETH opportunity passed scanner filters");

  const base = cfg.tokens.WETH, mid = cfg.tokens[c.intermediate];
  if (!mid) throw new Error("Unknown intermediate token");
  const asset = ethers.getAddress(base.address), intermediate = ethers.getAddress(mid.address);
  const buy = ethers.getAddress(c.buyRouter), sell = ethers.getAddress(c.sellRouter);
  const configuredPool = await new ethers.Contract(cfg.aaveAddressesProvider, [
    "function getPool() view returns (address)"
  ], provider).getPool();
  if ((await executor.pool()).toLowerCase() !== configuredPool.toLowerCase()) {
    throw new Error("Deployed executor is connected to a different Aave Pool");
  }
  const [assetAllowed, intermediateAllowed, buyAllowed, sellAllowed, buyFactoryOnchain, sellFactoryOnchain] = await Promise.all([
    executor.approvedToken(asset),
    executor.approvedToken(intermediate),
    executor.approvedRouter(buy),
    executor.approvedRouter(sell),
    executor.routerFactory(buy),
    executor.routerFactory(sell)
  ]);
  if (!assetAllowed || !intermediateAllowed || !buyAllowed || !sellAllowed) {
    throw new Error("On-chain token/router allowlist does not authorize this exact route");
  }
  for (const [addr, venue] of [[buy, cfg.venues.find(v => v.router?.toLowerCase() === buy.toLowerCase())],
                                [sell, cfg.venues.find(v => v.router?.toLowerCase() === sell.toLowerCase())]]) {
    if (!venue?.factory || venue.type !== "v2") throw new Error("Router is not in the approved V2 configuration");
    const [code, factory] = await Promise.all([
      provider.getCode(addr), new ethers.Contract(addr, routerAbi, provider).factory()
    ]);
    const boundFactory = addr.toLowerCase() === buy.toLowerCase() ? buyFactoryOnchain : sellFactoryOnchain;
    if (code === "0x" || factory.toLowerCase() !== venue.factory.toLowerCase() ||
        boundFactory.toLowerCase() !== venue.factory.toLowerCase()) {
      throw new Error("Router code/factory verification failed against both config and on-chain factory binding");
    }
  }
  for (const token of [asset, intermediate]) {
    if (await provider.getCode(token) === "0x") throw new Error("Token contract missing");
  }

  if (asset.toLowerCase() !== cfg.wrappedNative.toLowerCase()) {
    throw new Error("Live executor only supports the configured wrapped-native asset as the gas-reserve denomination");
  }

  const allowedAmounts = (cfg.scanAmounts ?? [])
    .filter(x => x.token === "WETH")
    .flatMap(x => x.amounts.map(String));
  if (!allowedAmounts.includes(String(c.amountIn))) {
    throw new Error("Candidate loan amount is not in the configured scan allowlist");
  }
  const amount = ethers.parseUnits(c.amountIn, base.decimals);
  if (amount <= 0n) throw new Error("Candidate amount must be positive");

  // Never trust the scanner's stored quote for execution. Re-quote both hops
  // from the configured routers immediately before estimating and simulating.
  const buyRouter = new ethers.Contract(buy, routerAbi, provider);
  const sellRouter = new ethers.Contract(sell, routerAbi, provider);
  const freshBuyAmounts = await buyRouter.getAmountsOut(amount, [asset, intermediate]);
  if (freshBuyAmounts.length !== 2 || freshBuyAmounts[1] <= 0n) {
    throw new Error("Fresh buy quote is invalid");
  }
  const freshMinIntermediateOut = minOut(freshBuyAmounts[1]);
  // Price the second hop using the minimum intermediate amount accepted from
  // hop one, so both slippage bounds remain jointly satisfiable.
  const freshSellAmounts = await sellRouter.getAmountsOut(
    freshMinIntermediateOut, [intermediate, asset]
  );
  if (freshSellAmounts.length !== 2 || freshSellAmounts[1] <= 0n) {
    throw new Error("Fresh sell quote is invalid");
  }
  const freshMinFinalOut = minOut(freshSellAmounts[1]);

  const aaveProvider = new ethers.Contract(cfg.aaveAddressesProvider, [
    "function getPool() view returns (address)"
  ], provider);
  const poolAddress = await aaveProvider.getPool();
  if (await provider.getCode(poolAddress) === "0x") {
    throw new Error("Aave Pool proxy has no code");
  }
  const pool = new ethers.Contract(poolAddress, [
    "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)"
  ], provider);
  const [flashPremiumBps, availableWeth] = await Promise.all([
    pool.FLASHLOAN_PREMIUM_TOTAL(),
    new ethers.Contract(asset, ["function balanceOf(address) view returns (uint256)"], provider)
      .balanceOf(poolAddress)
  ]);
  if (availableWeth < amount) {
    throw new Error("Aave WETH liquidity is below the requested flash-loan amount");
  }

  const fee = await provider.getFeeData();
  const feeFields = fee.maxFeePerGas
    ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n }
    : { gasPrice: fee.gasPrice };
  const cap = feeFields.maxFeePerGas ?? feeFields.gasPrice;
  if (!cap) throw new Error("No gas price available");

  const price = await getMinimumProfitWeth();
  const deadline = Math.floor(Date.now() / 1000) + 45;
  // The reserve is embedded in calldata, so estimate gas and L1 data fees
  // repeatedly using the exact candidate calldata until the reserve converges.
  // Any RPC instability or failure to converge causes a safe refusal.
  const route = {
    intermediateToken: intermediate, buyRouter: buy, sellRouter: sell,
    minIntermediateOut: freshMinIntermediateOut,
    minFinalOut: freshMinFinalOut,
    gasReserveInAsset: 1n, minProfit: price.minimumWethWei, deadline
  };
  const populate = r => executor.start.populateTransaction(asset, amount, r);
  let tx;
  let gas = 0n;
  let l1Fee = 0n;
  let l2Cost = 0n;
  let txGasLimit = 0n;
  let reserve = 1n;
  let converged = false;
  for (let i = 0; i < 12; i++) {
    tx = await populate(route);
    const [measuredGas, measuredL1Fee] = await Promise.all([
      provider.estimateGas({ ...tx, from: wallet.address, ...feeFields }),
      getL1Fee(tx.data ?? "0x")
    ]);
    const measuredL2Cost = measuredGas * cap;
    const measuredTxGasLimit = ceilDiv(measuredGas * 120n, 100n);
    const nextReserve = ceilDiv((measuredTxGasLimit * cap + measuredL1Fee) * buffer, 10000n);
    gas = measuredGas;
    txGasLimit = measuredTxGasLimit;
    l1Fee = measuredL1Fee;
    if (nextReserve === reserve) {
      converged = true;
      break;
    }
    reserve = nextReserve;
    route.gasReserveInAsset = reserve;
  }
  if (!converged) {
    throw new Error("Final-calldata L2/L1 gas reserve did not converge; refusing execution");
  }
  // tx is populated with the converged reserve. Re-estimate once more against
  // that exact calldata and ensure its required reserve still matches.
  tx = await populate(route);
  const [finalGas, finalL1Fee] = await Promise.all([
    provider.estimateGas({ ...tx, from: wallet.address, ...feeFields }),
    getL1Fee(tx.data ?? "0x")
  ]);
  txGasLimit = ceilDiv(finalGas * 120n, 100n);
  const finalReserve = ceilDiv((txGasLimit * cap + finalL1Fee) * buffer, 10000n);
  if (finalReserve !== route.gasReserveInAsset) {
    throw new Error("Final calldata changed its gas reserve after verification; refusing execution");
  }
  gas = finalGas;
  l1Fee = finalL1Fee;
  l2Cost = txGasLimit * cap;
  reserve = finalReserve;

  const walletBalance = await provider.getBalance(wallet.address);
  if (walletBalance < reserve) {
    throw new Error(`Wallet ETH balance ${ethers.formatEther(walletBalance)} is below the buffered gas reserve ${ethers.formatEther(reserve)}`);
  }
  const exactTx = { ...tx, from: wallet.address, gasLimit: txGasLimit, ...feeFields };
  // This exact simulation enforces: principal + Aave premium + buffered L1/L2
  // gas reserve + at least $0.01 (converted using a fresh ETH/USD oracle).
  await provider.call(exactTx);

  const report = {
    mode: LIVE ? "LIVE — only if explicitly enabled" : "SIMULATION ONLY",
    candidate: { amount: c.amountIn, intermediate: c.intermediate, buy: c.buyVenue, sell: c.sellVenue, quoteBlock },
    minimumNetProfitUsd: `${(minProfitUsdCents / 100n).toString()}.${(minProfitUsdCents % 100n).toString().padStart(2, "0")}`,
    minimumNetProfitWeth: ethers.formatEther(price.minimumWethWei),
    ethUsdAnswer: price.ethUsdAnswer,
    ethUsdFeedUpdatedAt: price.updatedAt,
    aaveFlashLoanPremiumBps: flashPremiumBps.toString(),
    freshBuyQuoteWethToIntermediate: freshBuyAmounts[1].toString(),
    freshSellQuoteIntermediateToWeth: freshSellAmounts[1].toString(),
    estimatedGas: gas.toString(),
    transactionGasLimitWith20PercentHeadroom: txGasLimit.toString(),
    maxL2GasCostWei: l2Cost.toString(),
    finalCalldataL1FeeWei: l1Fee.toString(),
    gasReserveBufferBps: buffer.toString(),
    bufferedGasReserveWeth: ethers.formatEther(reserve),
    walletEthBalance: ethers.formatEther(walletBalance),
    exactFinalTransactionSimulation: "PASSED",
    feeAccounting: "Aave premium is repaid on-chain; both DEX fees/price impact are reflected in fresh router quotes; the contract requires gross surplus to exceed a conservative L1+L2 gas reserve plus the USD profit floor. The reserve is a gate, not a fee deducted or paid by the contract; the EOA pays network gas. Reverted transactions can still consume gas."
  };
  console.log(JSON.stringify(report, null, 2));
  if (!LIVE) {
    console.log("Simulation only; no transaction sent.");
    return;
  }

  const response = await wallet.sendTransaction({ ...tx, gasLimit: txGasLimit, ...feeFields });
  console.log("Broadcast transaction:", response.hash);
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");
  const effectiveGasPrice = receipt.effectiveGasPrice ?? receipt.gasPrice ?? cap;
  const actualL2 = receipt.gasUsed * effectiveGasPrice;
  // Base receipts may omit l1Fee depending on the RPC. Prefer the receipt field;
  // otherwise query the Base L1 fee oracle for this exact calldata and label it estimated.
  const l1FeeIsReceipt = receipt.l1Fee !== undefined && receipt.l1Fee !== null;
  const actualL1 = l1FeeIsReceipt ? receipt.l1Fee : await getL1Fee(tx.data ?? "0x");
  let grossProfit = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== (await executor.getAddress()).toLowerCase()) continue;
    try {
      const parsed = executor.interface.parseLog(log);
      if (parsed?.name === "ArbitrageCompleted") grossProfit = parsed.args.grossProfit;
    } catch {}
  }
  const actualNet = grossProfit === null ? null : grossProfit - actualL2 - actualL1;
  const actualNetUsd = actualNet === null ? null :
    Number(actualNet) * Number(price.ethUsdAnswer) / (10 ** (18 + price.feedDecimals));
  console.log(JSON.stringify({
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    actualL2GasCostWei: actualL2.toString(),
    actualL1FeeWei: actualL1.toString(),
    l1FeeSource: l1FeeIsReceipt ? "receipt" : "post-receipt Base oracle estimate; verify independently",
    grossContractSurplusWeth: grossProfit === null ? null : ethers.formatEther(grossProfit),
    estimatedNetProfitAfterL1AndL2Weth: actualNet === null ? null : ethers.formatEther(actualNet),
    estimatedNetProfitAfterL1AndL2Usd: actualNetUsd === null ? null : actualNetUsd.toFixed(6),
    minimumRequiredNetProfitUsd: Number(minProfitUsdCents) / 100,
    note: "The contract's gas reserve is a pre-trade safety threshold, not a fee paid by the contract. EOA gas is deducted here from gross contract surplus. If L1 fee came from the oracle fallback, the net figure is an estimate, not an exact historical receipt value."
  }, null, 2));
}
main().catch(e => {
  console.error("Executor stopped:", e.shortMessage ?? e.message);
  process.exitCode = 1;
});
