/**
 * D-09 — one-time bulk backfill of ALL inrSpend=0 Spend rows
 * (`pnpm fx:backfill`), plus a re-run to PROVE idempotency.
 *
 * The real backfill logic lives in `backfillInrZeroRows` (src/lib/fx-store.ts),
 * which the daily fast tick (runFastTick) also runs — so a manual run here and
 * the scheduled tick are the same code path.
 *
 * Guards honoured: NEVER deletes rows; INR rows stamp the 1:1 identity rate;
 * a currency with no stored rate + all live FX sources unreachable → BLOCKED
 * with the EXACT per-source error strings, rows left untouched (no fake rate).
 *
 * Evidence: appends a run summary to .fx-evidence.txt (gitignored scratch).
 */
import { readFileSync, appendFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import { backfillInrZeroRows, InrZeroBackfillResult } from "../src/lib/fx-store";

// Load .env like the scheduler does (a bare tsx process doesn't auto-load it).
function loadDotEnv(): void {
  const envPath = ".env";
  try {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (!m || line.trim().startsWith("#")) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {
    /* .env absent → the function's own live-fetch fallbacks still apply */
  }
}

async function main() {
  loadDotEnv();
  const out: string[] = [];
  const log = (s: string) => {
    out.push(s);
    console.log(s);
  };

  log(`FX BACKFILL RUN — ${new Date().toISOString()}`);
  const before = await backfillInrZeroRows(prisma);
  const report = (r: InrZeroBackfillResult, tag: string) => {
    log(`[${tag}] scanned=${r.scanned} consistent=${r.consistent} rateStamped=${r.rateStamped} recovered=${r.recovered} updates=${r.updates} blocked=${r.blocked.length}`);
    log(
      `[${tag}] INR total: ${r.totalInrBefore.toFixed(2)} → ${r.totalInrAfter.toFixed(2)} (Δ ${(r.totalInrAfter - r.totalInrBefore).toFixed(2)})`,
    );
    log(`[${tag}] inrSpend=0 rows: ${r.zeroRowsBefore} → ${r.zeroRowsAfter} (un-stamped inrRate=0 rows)`);
    if (r.blocked.length) {
      log(`[${tag}] BLOCKED (no rate, FX sources unreachable — rows left untouched, exact errors):`);
      for (const b of r.blocked) log(`    ${b.currency} ${b.day}: ${b.errors.join(" | ")}`);
      process.exitCode = 1; // blocked = the ticket's "BLOCKED with exact error", never a fake rate
    }
  };
  report(before, "RUN-1");

  // Idempotency proof: the second run must be byte-identical (0 updates).
  const after = await backfillInrZeroRows(prisma);
  log(`[IDEMPOTENCY] re-run updates=${after.updates} recovered=${after.recovered} consistent=${after.consistent} — ${after.updates === 0 ? "byte-identical (no changes)" : "CHANGED (investigate)"}`);
  if (after.updates !== 0) process.exitCode = 1;

  appendFileSync(".fx-evidence.txt", out.join("\n") + "\n");
  log(`evidence appended to .fx-evidence.txt (gitignored).`);
  // Let the event loop drain (a hard process.exit on Windows can crash libuv).
}

main().catch((e) => {
  console.error("fx-backfill crashed:", e);
  process.exitCode = 1;
});
