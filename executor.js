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
  "function start(address,uint256,(address,address,address,uint256,uint256,uint256,uint256,uint256))"
], wallet);
const routerAbi = ["function factory() view returns (address)"];
const l1Oracle = "0x420000000000000000000000000000000000000F";
const l1Iface = new ethers.Interface(["function getL1Fee(bytes data) view returns (uint256)"]);
const slip = BigInt(process.env.SLIPPAGE_BPS ?? "30");
const buffer = BigInt(process.env.GAS_BUFFER_BPS ?? "15000");
const minProfit = BigInt(process.env.MIN_PROFIT_BASE_UNITS ?? cfg.minProfitBaseUnits);
const minOut = x => x * (10000n - slip) / 10000n;

async function main() {
  if (cfg.chainId !== 8453 || Number((await provider.getNetwork()).chainId) !== 8453) {
    throw new Error("Executor is restricted to Base Mainnet (chain 8453)");
  }
  if (slip < 1n || slip > 500n || buffer < 10000n || buffer > 20000n) throw new Error("Unsafe slippage or gas-buffer setting");
  if ((await executor.owner()).toLowerCase() !== wallet.address.toLowerCase()) throw new Error("Wallet is not contract owner");

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
    if (code === "0x" || factory.toLowerCase() !== venue.factory.toLowerCase()) throw new Error("Router code/factory verification failed");
  }
  for (const token of [asset, intermediate]) if (await provider.getCode(token) === "0x") throw new Error("Token contract missing");

  const amount = ethers.parseUnits(c.amountIn, base.decimals);
  const fee = await provider.getFeeData();
  const feeFields = fee.maxFeePerGas
    ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n }
    : { gasPrice: fee.gasPrice };
  const cap = feeFields.maxFeePerGas ?? feeFields.gasPrice;
  if (!cap) throw new Error("No gas price available");
  const deadline = Math.floor(Date.now() / 1000) + 45;
  const route = {
    intermediateToken: intermediate, buyRouter: buy, sellRouter: sell,
    minIntermediateOut: minOut(BigInt(c.intermediateOutRaw)),
    minFinalOut: minOut(BigInt(c.finalOutRaw)),
    gasCostInAsset: 0n, minProfit, deadline
  };
  const populate = r => executor.start.populateTransaction(asset, amount, r);
  let tx = await populate(route);
  const gas = await provider.estimateGas({ ...tx, from: wallet.address, ...feeFields });
  // Base has both L2 execution gas and an L1 calldata fee. Fail closed if oracle fails.
  const data = l1Iface.encodeFunctionData("getL1Fee", [tx.data ?? "0x"]);
  const l1Raw = await provider.call({ to: l1Oracle, data });
  const l1Fee = l1Iface.decodeFunctionResult("getL1Fee", l1Raw)[0];
  const l2Cost = gas * cap;
  const reserve = (l2Cost + l1Fee) * buffer / 10000n;
  route.gasCostInAsset = reserve;
  tx = await populate(route);
  const exactTx = { ...tx, from: wallet.address, gasLimit: gas, ...feeFields };
  await provider.call(exactTx);
  console.log(JSON.stringify({
    mode: LIVE ? "LIVE" : "SIMULATION ONLY",
    candidate: { amount: c.amountIn, intermediate: c.intermediate, buy: c.buyVenue, sell: c.sellVenue, quoteBlock },
    estimatedGas: gas.toString(), estimatedL2CostWei: l2Cost.toString(),
    estimatedL1DataFeeWei: l1Fee.toString(), bufferedReserveWeth: ethers.formatEther(reserve),
    minimumProfitWeth: ethers.formatEther(minProfit), simulated: true
  }, null, 2));
  if (!LIVE) { console.log("Simulation only; no transaction sent."); return; }

  const response = await wallet.sendTransaction({ ...tx, gasLimit: gas, ...feeFields });
  console.log("Broadcast transaction:", response.hash);
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted");
  console.log(JSON.stringify({
    transactionHash: receipt.hash, blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    actualL2GasCostEth: ethers.formatEther(receipt.gasUsed * (receipt.gasPrice ?? cap)),
    note: "Base L1 data fee is additional; inspect receipt and ArbitrageCompleted event for realized net profit."
  }, null, 2));
}
main().catch(e => { console.error("Executor stopped:", e.shortMessage ?? e.message); process.exitCode = 1; });
