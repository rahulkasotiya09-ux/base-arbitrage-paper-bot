# Aave V3 Flash-Arbitrage (Ethereum Mainnet)

This repository now contains three separate pieces:

1. `scanner.js`: read-only same-block DEX quote scanner. It only labels WETH-denominated routes as candidates because native ETH gas can be directly reserved in WETH units.
2. `src/AaveV3FlashArb.sol`: owner-operated Aave V3 `flashLoanSimple` receiver. It performs two allowlisted Uniswap-V2-compatible swaps, approves Aave for principal + the premium returned by Aave, and reverts unless the borrowed-asset balance covers repayment, the caller's conservative gas reserve, and the minimum desired profit.
3. `executor.js`: reads the scanner output, selects a V2/V2 WETH candidate, estimates gas, reserves gas in WETH, then simulates the complete transaction with `eth_call`. It does not broadcast by default.

## Important: not a guaranteed-profit machine

Arbitrage opportunities are highly competitive and can disappear before inclusion. A successful simulation is only a point-in-time result. MEV, slippage, RPC latency, competing transactions, reorgs, gas-price changes, and reverted transactions can erase expected returns. A reverted on-chain transaction still costs the sender gas.

The flash-loan principal and Aave premium are repaid atomically in the same transaction. Transaction gas is paid separately by the sending wallet in native ETH; it is not paid to Aave from the borrowed tokens. The contract's `gasCostInAsset` parameter is a conservative WETH reserve used in its profit check, not an exact measurement of the sender's eventual gas bill. The executor estimates gas and adds a configurable buffer, then simulates again with that reserve.

The initial executor supports only two V2-style routers. V3 venues may be scanned for research, but are not selected by this executor. Do not interpret a scanner candidate as executable until the executor's simulation succeeds.

## Local setup

Requirements: Node.js 20+, Foundry, and a trusted Ethereum mainnet RPC endpoint.

```bash
npm install
cp .env.example .env
# Set RPC_URL in .env
npm run check
npm run scan
```

The scanner writes `opportunities.json`. It uses the same block tag for the quote calls in one scan and sorts profits with integer arithmetic. It excludes non-WETH borrowed assets from the profitable-candidate list rather than pretending their gas costs have been converted.

## Contract build and fork tests

```bash
forge install foundry-rs/forge-std --no-git
forge build
RPC_URL="https://YOUR_MAINNET_RPC" forge test --fork-url "$RPC_URL" -vvv
```

Fork tests check that the configured Aave V3 Ethereum Pool resolves, that the receiver uses that Pool, owner checks work, and an intentionally losing same-router WETH/USDC round trip is rejected. Fork tests require a mainnet RPC URL and are not run in CI unless the repository secret `RPC_URL` is configured.

## Deployment and configuration (manual; not performed by this bot)

The Aave V3 Ethereum Mainnet PoolAddressesProvider used by the fork test is:

`0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e`

Build and deploy only after reviewing the source and test results. For example, with a dedicated deployment wallet and Foundry:

```bash
forge create --rpc-url "$RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  src/AaveV3FlashArb.sol:AaveV3FlashArb \
  --constructor-args 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e
```

Then, from the contract owner wallet, allowlist only the exact assets and router contracts you have independently verified. At minimum, allowlist WETH and the chosen intermediate token, and the exact Uniswap V2-compatible buy/sell routers. The contract starts with empty allowlists. Never allowlist arbitrary routers or tokens.

The executor requires `EXECUTOR_ADDRESS` and `WALLET_PRIVATE_KEY` in a local `.env` file. Use a dedicated wallet with no unrelated assets. Never commit `.env`, private keys, seed phrases, or RPC secrets to GitHub.

## Executor: simulation first

```bash
npm run simulate
```

This performs a gas estimate and a full `eth_call` simulation. It does not broadcast a transaction. It requires a deployed and configured contract, an owner wallet, and a recent `opportunities.json`.

Only after a separate security review and explicit decision to risk funds, live sending can be enabled by setting:

```dotenv
LIVE_TRADING=true
CONFIRM_LIVE_TRADING=I_ACCEPT_TRANSACTION_RISK
```

This switch is deliberately off by default. The assistant has not deployed a contract, received or stored a wallet key, signed a transaction, or moved funds.

## Environment

See `.env.example`. Keep secrets local or in GitHub Actions Secrets. Never paste a private key into chat or commit it to the repository.

## CI

`.github/workflows/checks.yml` runs JavaScript syntax checks and compiles Solidity. If the repository secret `RPC_URL` is configured, it also runs the Ethereum mainnet fork tests. The existing scanner workflow remains read-only.

## Current limitations before real-money use

- No audited security review; this code is experimental.
- No live deployment has been made.
- The contract supports two V2-style swaps only; it does not execute Uniswap V3 routes.
- The executor currently uses scanner snapshots as route hints and relies on on-chain simulation plus strict minimum outputs to reject stale or unprofitable trades.
- Gas reserve is an estimate and WETH is treated as 1:1 with ETH for that reserve.
- No private transaction relay / MEV protection is configured.
- No automated keeper loop is enabled; execution is a manual CLI invocation.
- The contract's `minProfit` is denominated in the borrowed asset and is a threshold after the supplied gas reserve, not a promise of profit.

Do not fund or deploy this until the fork tests pass on your own RPC, router/token addresses are independently verified, and an experienced Solidity auditor has reviewed the code.
