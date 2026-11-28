import "dotenv/config";
import fs from "node:fs";
import { ethers } from "ethers";
import { verifyNewTokenSecurity } from "./token-security.js";

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
const configuredRpc = process.env.RPC_URL;
const rpc = configuredRpc.replace(/\/$/, "") === "https://mainnet.base.org"
  ? "https://base-rpc.publicnode.com" : configuredRpc;
const provider = new ethers.JsonRpcProvider(rpc, cfg.chainId, { staticNetwork: true });
const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider);
const executor = new ethers.Contract(ethers.getAddress(process.env.EXECUTOR_ADDRESS), [
  "function owner() view returns (address)",
  "function pool() view returns (address)",
  "function poolManager() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function routerFactory(address) view returns (address)",
  "function routerType(address) view returns (uint8)",
  "function approvedToken(address) view returns (bool)",
  "function setToken(address token,bool approved)",
  "function approvedRouter(address) view returns (bool)",
  "event ArbitrageCompleted(address indexed asset,address indexed intermediateToken,uint256 principal,uint256 premium,uint256 grossProfit)",
  "function start(address asset,uint256 amount,(address intermediateToken,address buyRouter,address sellRouter,uint256 minIntermediateOut,uint256 minFinalOut,uint256 gasReserveInAsset,uint256 minProfit,uint256 deadline) route)",
  "function startV3(address asset,uint256 amount,(address intermediateToken,address buyRouter,address sellRouter,uint256 minIntermediateOut,uint256 minFinalOut,uint24 buyFee,uint24 sellFee,uint256 gasReserveInAsset,uint256 minProfit,uint256 deadline) route)",
  "function startV4(address asset,uint256 amount,(address intermediateToken,address buyRouter,address sellRouter,uint256 minIntermediateOut,uint256 minFinalOut,uint24 buyFee,uint24 sellFee,int24 buyTickSpacing,int24 sellTickSpacing,uint256 gasReserveInAsset,uint256 minProfit,uint256 deadline) route)",
  "function startMulti(address asset,uint256 amount,(address intermediateToken,address buyRouter,address sellRouter,uint256 minIntermediateOut,uint256 minFinalOut,uint24 buyFee,uint24 sellFee,int24 buyTickSpacing,int24 sellTickSpacing,bool buyStable,bool sellStable,uint256 gasReserveInAsset,uint256 minProfit,uint256 deadline) route)"
], wallet);
const routerAbi = [
  "function factory() view returns (address)",
  "function getAmountsOut(uint256 amountIn,address[] calldata path) view returns (uint256[] memory amounts)"
];
const v3QuoterAbi = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)"];
const v4QuoterAbi = ["function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params)"];
const aerodromeRouterAbi = [
  "function defaultFactory() view returns (address)",
  "function getAmountsOut(uint256 amountIn,tuple(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)"
];
const slipstreamQuoterAbi = ["function quoteExactInputSingleV3((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)"];
async function freshQuote(venue, tokenIn, tokenOut, amountIn, fee) {
  if (venue.type === "v2") {
    const amounts = await new ethers.Contract(venue.router, routerAbi, provider).getAmountsOut(amountIn, [tokenIn, tokenOut]);
    if (amounts.length !== 2) throw new Error("Invalid V2 quote");
    return amounts[1];
  }
  if (venue.type === "v3") {
    const q = await new ethers.Contract(venue.quoter, v3QuoterAbi, provider).quoteExactInputSingle.staticCall({
      tokenIn, tokenOut, amountIn, fee: Number(fee?.fee ?? fee), sqrtPriceLimitX96: 0
    });
    return q.amountOut ?? q[0];
  }
  if (venue.type === "aerodrome") {
    const amounts = await new ethers.Contract(venue.router, aerodromeRouterAbi, provider).getAmountsOut(
      amountIn, [{ from: tokenIn, to: tokenOut, stable: Boolean(fee), factory: venue.factory }]
    );
    if (amounts.length !== 2) throw new Error("Invalid Aerodrome quote");
    return amounts[1];
  }
  if (venue.type === "slipstream") {
    const q = await new ethers.Contract(venue.quoter, slipstreamQuoterAbi, provider).quoteExactInputSingleV3.staticCall({
      tokenIn, tokenOut, amountIn, tickSpacing: Number(fee), sqrtPriceLimitX96: 0
    });
    return q.amountOut ?? q[0];
  }
  if (venue.type === "v4") {
    if (amountIn > (2n ** 128n - 1n)) throw new Error("V4 quote amount exceeds uint128");
    const a = BigInt(tokenIn), b = BigInt(tokenOut);
    const params = {
      poolKey: {
        currency0: a < b ? tokenIn : tokenOut,
        currency1: a < b ? tokenOut : tokenIn,
        fee: Number(fee?.fee), tickSpacing: Number(fee?.tickSpacing), hooks: ethers.ZeroAddress
      },
      zeroForOne: a < b, exactAmount: amountIn, hookData: "0x"
    };
    const q = await new ethers.Contract(venue.quoter, v4QuoterAbi, provider).quoteExactInputSingle.staticCall(params);
    return q.amountOut ?? q[0];
  }
  throw new Error("Unsupported DEX venue type");
}
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

  const v4ExecutionEnabled = process.env.EXECUTOR_V4_ENABLED === "true";
  const output = JSON.parse(fs.readFileSync(new URL("./opportunities.json", import.meta.url), "utf8"));
  let watchlist = { tokens: [] };
  try { watchlist = JSON.parse(fs.readFileSync(new URL("./new-token-watchlist.json", import.meta.url), "utf8")); } catch {}
  const discoveredByAddress = new Map((watchlist.tokens ?? [])
    .filter(t => ethers.isAddress(t.address))
    .map(t => [t.address.toLowerCase(), t]));
  if (output.chainId !== 8453 || !Array.isArray(output.candidates)) {
    throw new Error("Opportunity file has the wrong chain or invalid candidate list");
  }
  const venueByName = new Map(cfg.venues.map(v => [v.name, v]));
  // Check each candidate against the exact deployed router registrations.
  // This supports V2/V2, V2/V3, V3/V2 and V3/V3 routes without assuming
  // that one globally selected V3 router represents every V3 leg.
  const compatible = (await Promise.all(output.candidates.map(async x => {
    const buyVenue = venueByName.get(x.buyVenue);
    const sellVenue = venueByName.get(x.sellVenue);
    if (x.base !== "WETH" || x.executorCompatible !== true ||
        ((x.buyType === "v4" || x.sellType === "v4") && !v4ExecutionEnabled) ||
        !x.buyRouter || !x.sellRouter || !x.intermediate ||
        !/^\d+$/.test(String(x.estimatedNetProfitRaw ?? "")) ||
        !buyVenue?.router || !sellVenue?.router ||
        buyVenue.router.toLowerCase() !== String(x.buyRouter).toLowerCase() ||
        sellVenue.router.toLowerCase() !== String(x.sellRouter).toLowerCase()) {
      return false;
    }
    const intermediateAddress = x.intermediateAddress ?? cfg.tokens[x.intermediate]?.address;
    if (!intermediateAddress || !ethers.isAddress(intermediateAddress)) return false;
    const tokenAddress = ethers.getAddress(intermediateAddress);
    const [baseAllowed, tokenAllowed, buyAllowed, sellAllowed] = await Promise.all([
      executor.approvedToken(cfg.tokens.WETH.address).catch(() => false),
      executor.approvedToken(tokenAddress).catch(() => false),
      executor.approvedRouter(buyVenue.router).catch(() => false),
      executor.approvedRouter(sellVenue.router).catch(() => false)
    ]);
    const discovered = discoveredByAddress.get(tokenAddress.toLowerCase());
    const securityFresh = discovered?.securityPassed === true &&
      discovered?.security?.passed === true &&
      discovered?.security?.chainId === 8453 &&
      Number.isFinite(Date.parse(discovered.security.checkedAt)) &&
      Date.now() - Date.parse(discovered.security.checkedAt) <= 10 * 60 * 1000;
    if (!baseAllowed || (!tokenAllowed && !securityFresh) || !buyAllowed || !sellAllowed) return false;
    for (const venue of [buyVenue, sellVenue]) {
      const expectedType = ({ v2: 1, v3: 2, v4: 3, aerodrome: 4, slipstream: 5 })[venue.type] ?? 0;
      if (!expectedType || Number(await executor.routerType(venue.router).catch(() => 0n)) !== expectedType) return false;
    }
    return true;
  }))).filter(Boolean);
  compatible.sort((a, b) => {
    const av = BigInt(a.estimatedNetProfitRaw);
    const bv = BigInt(b.estimatedNetProfitRaw);
    return av === bv ? 0 : (av > bv ? -1 : 1);
  });
  const c = compatible[0];
  if (!c) {
    console.log("No V2/V3 WETH candidate passed scanner filters and deployed router-approval checks; clean no-trade cycle.");
    return;
  }

  // Only validate quote age when a real candidate exists. The executor
  // independently re-quotes both swaps at the current head before simulation.
  const block = await provider.getBlockNumber();
  const quoteBlock = Number(output.block);
  const maxQuoteAgeBlocks = Number(cfg.maxQuoteAgeBlocks ?? 100);
  if (!Number.isSafeInteger(quoteBlock) || quoteBlock <= 0 ||
      !Number.isSafeInteger(maxQuoteAgeBlocks) || maxQuoteAgeBlocks < 1 ||
      block < quoteBlock || block - quoteBlock > maxQuoteAgeBlocks) {
    throw new Error("Candidate quote snapshot is too old or from a future block");
  }

  const base = cfg.tokens.WETH;
  let mid = cfg.tokens[c.intermediate];
  let discoveredToken = null;
  if (!mid && c.intermediateAddress && Number.isInteger(c.intermediateDecimals)) {
    const match = (watchlist.tokens ?? []).find(t => t.symbol === c.intermediate &&
      ethers.isAddress(t.address) && t.address.toLowerCase() === String(c.intermediateAddress).toLowerCase() &&
      Number(t.decimals) === c.intermediateDecimals);
    if (match) {
      discoveredToken = match;
      mid = { address: match.address, decimals: match.decimals, discoveryOnly: false };
    }
  }
  if (!mid) throw new Error("Unknown or unverified intermediate token; refusing execution");
  if (c.intermediateAddress && mid.address.toLowerCase() !== c.intermediateAddress.toLowerCase()) {
    throw new Error("Candidate intermediate token address mismatch");
  }
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
  if (!assetAllowed || !buyAllowed || !sellAllowed) {
    throw new Error("On-chain WETH/router allowlist does not authorize this exact route");
  }
  const needsDiscoveredTokenApproval = !intermediateAllowed;
  if (needsDiscoveredTokenApproval && (!discoveredToken ||
      discoveredToken.securityPassed !== true || discoveredToken.security?.passed !== true ||
      discoveredToken.security?.chainId !== 8453 ||
      !Number.isFinite(Date.parse(discoveredToken.security.checkedAt)) ||
      Date.now() - Date.parse(discoveredToken.security.checkedAt) > 10 * 60 * 1000)) {
    throw new Error("Unapproved token is not a freshly security-cleared discovery candidate");
  }
  const selectedVenues = [
    { addr: buy, venue: cfg.venues.find(v => v.router?.toLowerCase() === buy.toLowerCase()), boundFactory: buyFactoryOnchain, legFee: c.buyFee },
    { addr: sell, venue: cfg.venues.find(v => v.router?.toLowerCase() === sell.toLowerCase()), boundFactory: sellFactoryOnchain, legFee: c.sellFee }
  ];
  for (const { addr, venue, boundFactory, legFee } of selectedVenues) {
    if (!venue || !["v2", "v3", "v4", "aerodrome", "slipstream"].includes(venue.type)) throw new Error("Router is not in the approved venue configuration");
    const code = await provider.getCode(addr);
    if (code === "0x") throw new Error("Configured execution venue has no deployed code");
    if (venue.type === "v4") {
      if (!v4ExecutionEnabled || addr.toLowerCase() !== cfg.poolManager.toLowerCase()) {
        throw new Error("V4 execution is disabled or the PoolManager does not match config");
      }
      const [deployedManager, managerKind] = await Promise.all([
        executor.poolManager(), executor.routerType(addr)
      ]);
      if (deployedManager.toLowerCase() !== cfg.poolManager.toLowerCase() || Number(managerKind) !== 3) {
        throw new Error("Deployed executor is not bound to the canonical Base V4 PoolManager");
      }
      if (![{fee:500,tickSpacing:10},{fee:3000,tickSpacing:60},{fee:10000,tickSpacing:200}]
        .some(x => x.fee === Number(legFee?.fee) && x.tickSpacing === Number(legFee?.tickSpacing))) {
        throw new Error("Unsupported V4 fee/tick-spacing pair");
      }
      continue;
    }
    if (!venue.factory || boundFactory.toLowerCase() !== venue.factory.toLowerCase()) {
      throw new Error("Router factory binding failed");
    }
    const routerKind = Number(await executor.routerType(addr).catch(() => 0n));
    if (venue.type === "v2") {
      const factory = await new ethers.Contract(addr, routerAbi, provider).factory();
      if (factory.toLowerCase() !== venue.factory.toLowerCase() || routerKind !== 1) throw new Error("V2 router factory/type mismatch");
    } else if (venue.type === "v3") {
      if (routerKind !== 2) throw new Error("V3 router is not registered as type 2 on deployed executor");
      const fee = Number(legFee?.fee ?? legFee);
      if (![500, 3000, 10000].includes(fee)) throw new Error("Unsupported V3 fee tier");
      const pool = await new ethers.Contract(venue.factory, ["function getPool(address,address,uint24) view returns (address)"], provider)
        .getPool(asset, intermediate, fee);
      if (pool === ethers.ZeroAddress || await provider.getCode(pool) === "0x") throw new Error("Configured V3 factory has no deployed pool for selected token pair/fee");
    } else if (venue.type === "aerodrome") {
      if (routerKind !== 4) throw new Error("Aerodrome router is not registered as type 4 on deployed executor");
      const [factory, pool] = await Promise.all([
        new ethers.Contract(addr, ["function defaultFactory() view returns (address)"], provider).defaultFactory(),
        new ethers.Contract(venue.factory, ["function getPool(address,address,bool) view returns (address)"], provider)
          .getPool(asset, intermediate, Boolean(legFee))
      ]);
      if (factory.toLowerCase() !== venue.factory.toLowerCase() || pool === ethers.ZeroAddress || await provider.getCode(pool) === "0x")
        throw new Error("Aerodrome factory binding or stable/volatile pool validation failed");
    } else {
      if (routerKind !== 5) throw new Error("Slipstream router is not registered as type 5 on deployed executor");
      const spacing = Number(legFee);
      if (![1, 50, 100, 200, 2000].includes(spacing)) throw new Error("Unsupported Slipstream tick spacing");
      const [factory, pool] = await Promise.all([
        new ethers.Contract(addr, ["function factory() view returns (address)"], provider).factory(),
        new ethers.Contract(venue.factory, ["function getPool(address,address,int24) view returns (address)"], provider)
          .getPool(asset, intermediate, spacing)
      ]);
      if (factory.toLowerCase() !== venue.factory.toLowerCase() || pool === ethers.ZeroAddress || await provider.getCode(pool) === "0x")
        throw new Error("Slipstream factory binding or pool validation failed");
    }
  }
  for (const token of [asset, intermediate]) {
    if (await provider.getCode(token) === "0x") throw new Error("Token contract missing");
  }

  // Auto-approval is restricted to a scanner-profitable discovery candidate,
  // rechecked directly with GoPlus. Its actual on-chain cost is added to the
  // minimum profit gate before the arbitrage transaction is simulated.
  let discoveredApprovalCostWeth = 0n;
  const fee = await provider.getFeeData();
  const feeFields = fee.maxFeePerGas
    ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n }
    : { gasPrice: fee.gasPrice };
  const cap = feeFields.maxFeePerGas ?? feeFields.gasPrice;
  if (!cap) throw new Error("No gas price available");
  if (needsDiscoveredTokenApproval) {
    if (process.env.AUTO_APPROVE_DISCOVERED_TOKENS !== "true") {
      throw new Error("Profitable discovered token awaits AUTO_APPROVE_DISCOVERED_TOKENS=true");
    }
    if (!LIVE) throw new Error("Simulation mode cannot approve a new token; no approval was sent");
    const freshSecurity = await verifyNewTokenSecurity(intermediate);
    if (!freshSecurity.passed || freshSecurity.chainId !== 8453) {
      throw new Error("Fresh GoPlus security verification failed; token approval refused");
    }
    const approvalTx = await executor.setToken.populateTransaction(intermediate, true);
    const approvalGas = await provider.estimateGas({ ...approvalTx, from: wallet.address, ...feeFields });
    const approvalL1 = await getL1Fee(approvalTx.data ?? "0x");
    const approvalGasLimit = ceilDiv(approvalGas * 120n, 100n);
    const approvalReserve = ceilDiv((approvalGasLimit * cap + approvalL1) * buffer, 10000n);
    if (await provider.getBalance(wallet.address) < approvalReserve) {
      throw new Error("Wallet balance is below the buffered discovered-token approval cost");
    }
    await provider.call({ ...approvalTx, from: wallet.address, gasLimit: approvalGasLimit, ...feeFields });
    console.log("Approving GoPlus-cleared token on executor:", intermediate);
    const approvalResponse = await wallet.sendTransaction({ ...approvalTx, gasLimit: approvalGasLimit, ...feeFields });
    console.log("Token approval transaction:", approvalResponse.hash);
    const approvalReceipt = await approvalResponse.wait();
    if (!approvalReceipt || approvalReceipt.status !== 1) throw new Error("Discovered-token approval transaction reverted");
    const approvalEffectiveGasPrice = approvalReceipt.effectiveGasPrice ?? approvalReceipt.gasPrice ?? cap;
    const approvalActualL2 = approvalReceipt.gasUsed * approvalEffectiveGasPrice;
    const approvalActualL1 = approvalReceipt.l1Fee !== undefined && approvalReceipt.l1Fee !== null
      ? approvalReceipt.l1Fee : await getL1Fee(approvalTx.data ?? "0x");
    discoveredApprovalCostWeth = ceilDiv((approvalActualL2 + approvalActualL1) * buffer, 10000n);
    if (!(await executor.approvedToken(intermediate))) {
      throw new Error("Approval receipt succeeded but executor token allowlist did not update");
    }
    console.log("Token approval confirmed; buffered approval cost added to profit floor.");
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
  const buyVenue = selectedVenues[0].venue, sellVenue = selectedVenues[1].venue;
  const buyFee = Number(c.buyFee?.fee ?? c.buyFee ?? 0), sellFee = Number(c.sellFee?.fee ?? c.sellFee ?? 0);
  const buyTickSpacing = Number(c.buyFee?.tickSpacing ?? 0), sellTickSpacing = Number(c.sellFee?.tickSpacing ?? 0);
  const freshBuyOut = await freshQuote(buyVenue, asset, intermediate, amount, buyFee);
  if (freshBuyOut <= 0n) throw new Error("Fresh buy quote is invalid");
  const freshMinIntermediateOut = minOut(freshBuyOut);
  const freshSellOut = await freshQuote(sellVenue, intermediate, asset, freshMinIntermediateOut, sellFee);
  if (freshSellOut <= 0n) throw new Error("Fresh sell quote is invalid");
  const freshMinFinalOut = minOut(freshSellOut);

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

  const price = await getMinimumProfitWeth();
  const effectiveMinimumProfitWeth = price.minimumWethWei + discoveredApprovalCostWeth;
  const deadline = Math.floor(Date.now() / 1000) + 45;
  // The reserve is embedded in calldata, so estimate gas and L1 data fees
  // repeatedly using the exact candidate calldata until the reserve converges.
  // Any RPC instability or failure to converge causes a safe refusal.
  const hasMultiLeg = ["aerodrome", "slipstream"].includes(buyVenue.type) || ["aerodrome", "slipstream"].includes(sellVenue.type);
  const route = {
    intermediateToken: intermediate, buyRouter: buy, sellRouter: sell,
    minIntermediateOut: freshMinIntermediateOut,
    minFinalOut: freshMinFinalOut, buyFee, sellFee, buyTickSpacing, sellTickSpacing,
    buyStable: buyVenue.type === "aerodrome" && Boolean(c.buyFee),
    sellStable: sellVenue.type === "aerodrome" && Boolean(c.sellFee),
    gasReserveInAsset: 1n, minProfit: effectiveMinimumProfitWeth, deadline
  };
  const hasV4Leg = buyVenue.type === "v4" || sellVenue.type === "v4";
  const hasV3Leg = buyVenue.type === "v3" || sellVenue.type === "v3";
  const populate = r => hasMultiLeg
    ? executor.startMulti.populateTransaction(asset, amount, r)
    : hasV4Leg
      ? executor.startV4.populateTransaction(asset, amount, r)
      : hasV3Leg
        ? executor.startV3.populateTransaction(asset, amount, r)
        : executor.start.populateTransaction(asset, amount, {
        intermediateToken: r.intermediateToken,
        buyRouter: r.buyRouter,
        sellRouter: r.sellRouter,
        minIntermediateOut: r.minIntermediateOut,
        minFinalOut: r.minFinalOut,
        gasReserveInAsset: r.gasReserveInAsset,
        minProfit: r.minProfit,
        deadline: r.deadline
      });
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
    minimumNetProfitWeth: ethers.formatEther(effectiveMinimumProfitWeth),
    discoveredTokenApprovalBufferedCostWeth: ethers.formatEther(discoveredApprovalCostWeth),
    ethUsdAnswer: price.ethUsdAnswer,
    ethUsdFeedUpdatedAt: price.updatedAt,
    aaveFlashLoanPremiumBps: flashPremiumBps.toString(),
    freshBuyQuoteWethToIntermediate: freshBuyOut.toString(),
    freshSellQuoteIntermediateToWeth: freshSellOut.toString(),
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
