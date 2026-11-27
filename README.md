# Aave V3 Flash-Arbitrage (Ethereum Mainnet)

This repository now contains three separate pieces:

1. `scanner.js`: read-only same-block DEX quote scanner. It reads Aave's live flash-loan premium from the Pool at the scan block and only labels WETH-denominated routes as candidates because native ETH gas can be directly reserved in WETH units.
2. `src/AaveV3FlashArb.sol`: owner-operated Aave V3 `flashLoanSimple` receiver. It performs two allowlisted Uniswap-V2-compatible swaps, approves Aave for principal + the premium returned by Aave, and reverts unless the borrowed-asset balance covers repayment, the caller's conservative gas reserve, and the minimum desired profit.
3. `executor.js`: reads the scanner output, rejects stale quotes, selects a V2/V2 WETH candidate, estimates gas, reserves gas in WETH, then simulates the complete transaction with `eth_call`. It does not broadcast in the automated workflow.\n4. `bot.js`: repeatable monitor loop that runs the scanner and, when a deployed contract plus a dedicated wallet are configured, runs the full executor simulation. It never enables live trading by itself.

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

Fork tests check that the configured Aave V3 Ethereum Pool resolves, that the receiver uses that Pool, owner checks work, and an intentionally losing same-router WETH/USDC round trip is rejected. They also include a successful end-to-end case: the test forks Ethereum mainnet, uses the real Aave Pool, real WETH/USDC pair contracts and real Uniswap V2 + Sushi V2 routers, then deliberately adjusts the two pair reserves inside the disposable fork to create a known price spread. It executes the actual flash loan, both swaps, Aave premium repayment, and checks that the receiver retains the configured profit after a conservative gas reserve. This proves the contract flow can complete against the real protocol/router contracts under controlled fork conditions; it does NOT prove that a naturally occurring profitable spread currently exists in the live market. Fork tests require a mainnet RPC URL and are not run in CI unless the repository secret `RPC_URL` is configured.

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

## Automated GitHub monitor (simulation-only)\n\n`.github/workflows/flasharb-bot.yml` is configured for manual runs and a five-minute schedule. Add `RPC_URL` as a repository Actions secret. Optionally add `EXECUTOR_ADDRESS` and `WALLET_PRIVATE_KEY` as Actions secrets to run the full executor simulation after each scan. The workflow hard-sets `LIVE_TRADING=false`; it will never broadcast a transaction. GitHub scheduled and manual-dispatch workflows must exist on the repository default branch to be triggerable. Merge this workflow into the default branch before using either trigger.\n\n## Executor: simulation first

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
- The successful fork test intentionally changes pair reserves in the local fork to manufacture a price spread; it is an integration test, not evidence of a live arbitrage opportunity.
- No live deployment has been made.
- The contract supports two V2-style swaps only; it does not execute Uniswap V3 routes.
- The executor currently uses scanner snapshots as route hints and relies on on-chain simulation plus strict minimum outputs to reject stale or unprofitable trades.
- Gas reserve is an estimate and WETH is treated as 1:1 with ETH for that reserve.
- No private transaction relay / MEV protection is configured.
- The local `bot.js` runner continuously scans and can simulate, but it is not a hosted transaction keeper. The GitHub workflow is scheduled monitoring/simulation only and deliberately cannot send trades.
- The contract's `minProfit` is denominated in the borrowed asset and is a threshold after the supplied gas reserve, not a promise of profit.

Do not fund or deploy this until the fork tests pass on your own RPC, router/token addresses are independently verified, and an experienced Solidity auditor has reviewed the code.
