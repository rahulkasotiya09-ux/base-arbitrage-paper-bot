FLASHARB OPPORTUNITY SCANNER (READ-ONLY)

Purpose
- Reads live on-chain quotes from configured DEX routers/quoters.
- Tests two-leg routes: borrowed/base token -> intermediate token -> base token.
- Applies configured flash-loan premium.
- Estimates gas only when the borrowed token is the configured wrapped native token.
- Writes indicative candidates to opportunities.json.
- DOES NOT sign, send, or execute transactions.

Requirements
- Node.js 20+
- An Ethereum mainnet RPC endpoint (or change config.json for another supported network).
- RPC_URL in a local .env file.

Install and run
1. Copy .env.example to .env and set RPC_URL.
2. npm install
3. npm run scan

Configuration
- config.json controls chainId, wrappedNative, flashLoanPremiumBps, gasLimitEstimate,
  minProfitBaseUnits, token addresses/decimals, venues, and scan amounts.
- Router/quoter addresses are example Ethereum mainnet addresses. Verify each address
  against the protocol's official deployment docs before use.
- Uniswap V3 Quoter interface is QuoterV2-style. If a configured quoter uses another ABI,
  update the interface.
- V3 fee tiers are tested independently.
- A V2 route uses getAmountsOut. A V3 route uses QuoterV2 quoteExactInputSingle.

Important limitations
- A quote is not a guarantee that the same price will exist when a transaction is mined.
- This first version scans only configured token pairs and two-leg routes.
- It does not account for MEV, builder payments, RPC latency, nonce competition,
  private orderflow, reverts, gas refunds, or exact transaction gas.
- For non-WETH borrowed assets, it deliberately does not pretend to calculate gas-adjusted
  profit. Convert gas cost into the borrowed asset using a reliable oracle/route before
  treating those candidates as profitable.
- The configured premium is an assumption; verify the actual Aave reserve premium and
  contract deployment settings. Balancer flash-loan fees may differ.
- The scanner is read-only. It does not automatically execute trades or access private keys.

Security
- Keep private keys out of this project. No wallet signer is used.
- Do not add auto-execution until a fork-tested transaction builder, exact gas simulation,
  on-chain profitability checks, allowlisted routers/tokens, nonce handling, and independent
  security review are complete.
- Never use a candidate list as financial advice or a profit guarantee.


AUTOMATIC RUNNING ON UBUNTU VPS
1. Upload/extract project to a VPS.
2. Install Node.js 20+ and npm.
3. Copy .env.example to .env and set RPC_URL. Telegram is optional.
4. To enable Telegram alerts:
   - Create a bot using Telegram's official BotFather.
   - Get the bot token.
   - Send the bot a message once, then obtain your chat ID from the bot updates.
   - Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.
5. Run: chmod +x install_cron_ubuntu.sh && ./install_cron_ubuntu.sh
6. Cron runs every 5 minutes. Logs: logs/scanner.log
7. To test immediately: npm run scan
8. To disable cron: crontab -l | grep -v scanner.js | crontab -

Do not put wallet private keys in .env. This scanner is read-only.
Telegram alerts are based on quote snapshots and are not proof of executable profit.
