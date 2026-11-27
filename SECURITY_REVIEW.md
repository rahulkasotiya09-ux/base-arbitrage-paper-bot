# FlashArb security review — 2026-11-27

## Current status

**Research / fork-test stage only. Not approved for mainnet deployment or live trading.**

No contract has been deployed by this review. No wallet transaction was signed or broadcast.

## Changes made

- Flash-loan callback is restricted to the configured Aave Pool, this contract as initiator, the active loan asset/amount, and one callback per active loan.
- Token and router allowlists are owner-controlled; route execution checks them again inside the callback.
- Both V2 swaps check actual input/output balance deltas and clear router approvals.
- Aave repayment approval is exact and the post-flash-loan balance is checked after Aave has pulled repayment.
- The contract rejects routes with zero gas reserve or zero minimum profit.
- Executor refreshes both V2 quotes immediately before estimating/simulating, and calculates the second-hop floor using the first-hop minimum output.
- Executor verifies the deployed runtime bytecode hash, owner, Aave Pool pointer, and the exact on-chain token/router allowlists before considering a route.
- Executor checks fresh Chainlink ETH/USD data, Aave flash-loan premium and current WETH liquidity.
- L2 gas and Base L1 data fees are estimated from the final calldata with a buffer; failure to converge or simulate causes refusal.
- Live broadcast requires LIVE_TRADING=true, --broadcast, and an explicit confirmation string.
- The JavaScript Solidity compiler is pinned to 0.8.39; transitive tmp is overridden to patched 0.2.7.

## Verified in CI

- Solidity compilation succeeded.
- Read-only Base Mainnet preflight succeeded: Aave provider/Pool, Chainlink ETH/USD feed metadata/freshness, configured token bytecode, V2 router/factory mappings, V3 component bytecode, Aave premium, WETH liquidity, and deployment estimate.
- Fork tests passed, including a current-live-reserve test that does not alter pool reserves and confirms a same-venue losing round trip is rejected.
- A separate artificial-spread fork test demonstrates the callback/repayment path under a deliberately created profitable test condition; it is not evidence of live arbitrage profitability.
- Production dependency audit is enforced in CI for high/critical vulnerabilities.

## Remaining risks and blockers

1. This code has not had an independent professional smart-contract audit.
2. The gas reserve and minimum-profit values are supplied by the owner executor. The contract cannot independently know the final L2/L1 transaction fee or verify the USD value of the caller-supplied minimum. The executor is therefore a critical trusted component.
3. The executor's $0.01 floor is an off-chain Chainlink conversion; the contract itself only enforces the WETH-denominated floor it receives.
4. A public-mempool transaction can be copied, sandwiched, delayed, or become stale after simulation. A reverted transaction still consumes gas.
5. Router quotes are indicative and can change before inclusion. The final on-chain min-out and balance checks are the last line of protection, not a guarantee against gas loss.
6. The scanner's preliminary gas filter excludes Base L1 data fees. Only the executor performs the more complete buffered calculation.
7. The executor supports V2/V2 routes only. V3 scanner results are research-only.
8. The executor now requires EXECUTOR_CODE_HASH. After deployment, the exact runtime code hash must be independently checked and configured before simulation or live execution.
9. No real transaction should be sent until the deployed bytecode is verified, the executor is configured, a fresh exact simulation passes, and the user approves the displayed maximum cost.

## Deployment gate

Do not deploy or trade automatically. Require a fresh preflight, code-hash verification, a successful exact-call simulation, a route with at least USD $0.01 remaining after the full buffered cost calculation, and separate explicit user approval for the specific transaction.
