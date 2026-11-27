import "dotenv/config";
import { spawnSync } from "node:child_process";

const intervalMs = Number(process.env.SCAN_INTERVAL_MS ?? "30000");
if (!Number.isSafeInteger(intervalMs) || intervalMs < 15000) {
  throw new Error("SCAN_INTERVAL_MS must be an integer of at least 15000");
}
const once = process.env.RUN_ONCE === "true";
const hasExecutor = Boolean(process.env.EXECUTOR_ADDRESS && process.env.WALLET_PRIVATE_KEY);

function run(script, label) {
  const result = spawnSync(process.execPath, [script], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} exited with status ${result.status}`);
}

async function cycle() {
  const started = Date.now();
  console.log(`\\n[FlashArb] Scan started ${new Date().toISOString()}`);
  run("scanner.js", "Scanner");
  if (hasExecutor) {
    console.log("[FlashArb] Contract and wallet configured; running full transaction simulation.");
    run("executor.js", "Executor");
  } else {
    console.log("[FlashArb] SCAN-ONLY: no executor address and wallet configured. No transaction can be sent.");
  }
  console.log(`[FlashArb] Cycle complete in ${Date.now()-started} ms.`);
}

do {
  try { await cycle(); }
  catch (error) { console.error("[FlashArb] Cycle failed:", error.message); }
  if (once) break;
  console.log(`[FlashArb] Sleeping ${intervalMs} ms. Stop with Ctrl+C.`);
  await new Promise(resolve => setTimeout(resolve, intervalMs));
} while (true);
