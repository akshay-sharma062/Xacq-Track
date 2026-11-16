/**
 * D-18 — one-off clear of leftover secrets on EXISTING active header-less
 * webhook connections (`pnpm webhooks:clear-unsigned`).
 *
 * WHY: connections created BEFORE D-18 (or by the pre-D-18 generate path) for
 * a UNSIGNED_ONLY platform (flexifunnels / cosmofeed / tagmango — the
 * providers that cannot send a secret header) may carry a generated
 * endpointSecret. That secret is useless and actively harmful: verify() then
 * requires an `x-webhook-secret` header the provider never sends, so every
 * real POST logs "verification failed" (the exact PO symptom on the
 * cl_abhishek-pal-fml `flexi` row). This empties it so the connection runs
 * unsigned.
 *
 * GUARDRAILS (the ticket's non-negotiables):
 *   - UNSIGNED_ONLY platforms ONLY — a signed-capable row (razorpay/cashfree/
 *     …) is skipped, never cleared (clearing it would open an unsigned POST
 *     path). The script reports how many it skipped.
 *   - ACTIVE connections only (default; revoked rows are dead — their past
 *     secret is audit trail, the PO re-mints a fresh connection for re-pointing).
 *   - endpointSecret is the ONLY field written; inboundUrl / conn log /
 *     keyHash are untouched. Idempotent: run twice, the 2nd reports 0 changed.
 *
 * Evidence: appends a concise run summary to .d18-clear-evidence.txt
 * (gitignored scratch, same convention as .d13a-refresh-evidence.txt).
 */
import { readFileSync, appendFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import { clearUnsignedWebhookSecrets, ClearUnsignedResult } from "../src/lib/integrations";

// Load .env like the other scripts do (a bare tsx process doesn't auto-load it).
function loadDotEnv(): void {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (!m || line.trim().startsWith("#")) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* .env absent — the helper's own env fallbacks still apply */ }
}

function fmt(r: ClearUnsignedResult): string[] {
  const lines: string[] = [
    `CLEAR UNSIGNED WEBHOOK SECRETS — ${new Date().toISOString()}`,
    `changed=${r.cleared} already-unsigned=${r.already} skipped-signed=${r.skippedSigned} (total ${r.rows.length} rows)`,
  ];
  for (const row of r.rows) {
    lines.push(`  ${row.changed ? "(cleared)" : row.platform === "razorpay" || row.platform === "cashfree" ? "(signed — kept)" : "(unsigned)"} ${row.platform}/${row.label}`);
  }
  lines.push(`RESULT: cleared=${r.cleared} already=${r.already} skippedSigned=${r.skippedSigned} — idempotent: re-run reports 0 cleared / all already.`);
  return lines;
}

async function main() {
  loadDotEnv();
  // Default = active-only (the ticket's scope). `--all` clears active + revoked.
  const all = process.argv.includes("--all");
  const res = await clearUnsignedWebhookSecrets(prisma, !all);

  for (const l of fmt(res)) console.log(l);
  try {
    appendFileSync(".d18-clear-evidence.txt", fmt(res).join("\n") + "\n\n", "utf8");
  } catch { /* evidence scratch is best-effort; the stdout above is the record */ }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("unsigned-flexi FAILED:", e);
  process.exit(1);
});
