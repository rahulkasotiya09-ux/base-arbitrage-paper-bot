import { ethers } from "ethers";

const API = "https://api.gopluslabs.io/api/v1/token_security/8453";

let nextGoPlusRequestAt = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getGoPlusPayload(url) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = Date.now();
    const wait = Math.max(0, nextGoPlusRequestAt - now);
    nextGoPlusRequestAt = Math.max(now, nextGoPlusRequestAt) + 1500;
    if (wait) await sleep(wait);

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) throw new Error(`GoPlus security API HTTP ${response.status}`);
        lastError = new Error(`GoPlus security API HTTP ${response.status}`);
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 20000)
          : Math.min(2000 * (2 ** attempt), 16000);
        if (attempt < 4) await sleep(delay);
        continue;
      }

      const payload = await response.json();
      if (String(payload.code) === "1" && payload.result && typeof payload.result === "object") {
        return payload;
      }
      const message = String(payload.message ?? "unknown response");
      const limited = /too many requests|rate.?limit|quota|429/i.test(message);
      if (!limited) throw new Error(`GoPlus returned no authoritative result: ${message}`);
      lastError = new Error(`GoPlus rate limited the security request: ${message}`);
      if (attempt < 4) await sleep(Math.min(2000 * (2 ** attempt), 16000));
    } catch (error) {
      lastError = error;
      if (/no authoritative result/.test(String(error.message))) throw error;
      if (attempt < 4) await sleep(Math.min(1000 * (2 ** attempt), 12000));
    }
  }
  throw lastError ?? new Error("GoPlus security API unavailable after retries");
}

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
  const payload = await getGoPlusPayload(url);
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
