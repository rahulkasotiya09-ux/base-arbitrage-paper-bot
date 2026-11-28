import { ethers } from "ethers";

const API = "https://api.gopluslabs.io/api/v1/token_security/8453";
const REQUIRED_ZERO_FLAGS = [
  "is_honeypot", "cannot_buy", "cannot_sell_all", "is_blacklisted",
  "slippage_modifiable", "transfer_pausable", "hidden_owner",
  "can_take_back_ownership", "owner_change_balance", "is_mintable"
];

export async function verifyNewTokenSecurity(address) {
  if (!ethers.isAddress(address)) throw new Error("Invalid token address for security check");
  const normalized = ethers.getAddress(address);
  const url = new URL(API);
  url.searchParams.set("contract_addresses", normalized.toLowerCase());
  let response;
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (response.ok) break;
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`GoPlus security API HTTP ${response.status}`);
      }
      lastError = new Error(`GoPlus security API HTTP ${response.status}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 15000)
        : Math.min(1500 * (2 ** attempt), 12000);
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, delayMs));
    } catch (error) {
      lastError = error;
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(1500 * (2 ** attempt), 12000)));
    }
  }
  if (!response?.ok) throw lastError ?? new Error("GoPlus security API unavailable after retries");
  const payload = await response.json();
  if (String(payload.code) !== "1" || !payload.result || typeof payload.result !== "object") {
    throw new Error(`GoPlus returned no authoritative result: ${payload.message ?? "unknown response"}`);
  }
  const data = payload.result[normalized.toLowerCase()] ?? payload.result[normalized];
  if (!data || typeof data !== "object") throw new Error("GoPlus has no security record for this token");

  const requireFlag = (key, expected) => {
    if (String(data[key] ?? "") !== expected) {
      throw new Error(`GoPlus ${key} is missing, unknown, or unsafe (${String(data[key] ?? "missing")})`);
    }
  };
  requireFlag("is_open_source", "1");
  requireFlag("is_in_dex", "1");
  for (const key of REQUIRED_ZERO_FLAGS) requireFlag(key, "0");

  // Router quotes do not account for transfer taxes. Require explicit zero
  // buy, sell and transfer tax; unknown/blank values fail closed.
  for (const key of ["buy_tax", "sell_tax", "transfer_tax"]) {
    const raw = data[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      throw new Error(`GoPlus ${key} is unknown; refusing new-token execution`);
    }
    const tax = Number(raw);
    if (!Number.isFinite(tax) || tax !== 0) {
      throw new Error(`GoPlus ${key} is non-zero or invalid (${String(raw)}); refusing new-token execution`);
    }
  }

  return {
    passed: true,
    provider: "GoPlus Token Security API",
    checkedAt: new Date().toISOString(),
    chainId: 8453,
    tokenAddress: normalized,
    isOpenSource: true,
    isInDex: true,
    buyTax: 0,
    sellTax: 0,
    transferTax: 0,
    checks: [...REQUIRED_ZERO_FLAGS, "is_open_source", "is_in_dex", "buy_tax", "sell_tax", "transfer_tax"]
  };
}
