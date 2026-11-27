import "dotenv/config";
import { spawnSync } from "node:child_process";

const intervalMs = Number(process.env.SCAN_INTERVAL_MS ?? "300000");
if (!Number.isSafeInteger(intervalMs) || intervalMs < 15000) {
  throw new Error("SCAN_INTERVAL_MS must be an integer of at least 15000");
}
const once = process.env.RUN_ONCE === "true";
const hasExecutor = Boolean(process.env.EXECUTOR_ADDRESS && process.env.EXECUTOR_CODE_HASH && process.env.WALLET_PRIVATE_KEY && process.env.RPC_URL);
const live = process.env.LIVE_TRADING === "true";
const liveConfirmed = process.env.CONFIRM_LIVE_TRADING === "I_ACCEPT_TRANSACTION_RISK";
if (live && !liveConfirmed) throw new Error("Live mode requires explicit CONFIRM_LIVE_TRADING acknowledgement.");
if (live && !hasExecutor) throw new Error("LIVE_TRADING is enabled but executor address, code hash, RPC URL, or wallet key is missing; refusing scan-only fallback.");

function run(script, label, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} exited with status ${result.status}`);
}

async function cycle() {
  const started = Date.now();
  console.log(`\n[FlashArb] Scan started ${new Date().toISOString()}`);
  run("scanner.js", "Scanner");
  if (hasExecutor) {
    console.log(live ? "[FlashArb] LIVE MODE: executor will re-quote, estimate, simulate, then broadcast only if every guard passes." : "[FlashArb] Simulation mode: no transaction will be sent.");
    run("executor.js", "Executor", live ? ["--broadcast"] : []);
  } else {
    console.log("[FlashArb] SCAN-ONLY: no executor address and wallet configured. No transaction can be sent.");
  }
  console.log(`[FlashArb] Cycle complete in ${Date.now()-started} ms.`);
}

do {
  try {
    await cycle();
  } catch (error) {
    console.error("[FlashArb] Cycle failed:", error.message);
    process.exitCode = 1;
  }
  if (once) break;
  console.log(`[FlashArb] Sleeping ${intervalMs} ms. Stop with Ctrl+C.`);
  await new Promise(resolve => setTimeout(resolve, intervalMs));
} while (true);
