/**
 * D-13a — one-off refresh of EXISTING webhook connections' inboundUrl
 * (`pnpm webhooks:refresh-url`).
 *
 * WHY: connections created before PUBLIC_BASE_URL existed (or while it was
 * unset) carry `http://localhost:3000/...` in their inboundUrl — an external
 * provider (FlexiFunnels) can never reach that host and rejects the URL.
 * This rewrites ONLY the inboundUrl string on every WebhookEndpoint row
 * (active AND revoked) using the current base (PUBLIC_BASE_URL >
 * NEXT_PUBLIC_BASE_URL > localhost-dev, per resolveWebhookBase). It NEVER
 * touches endpointSecret, keyHash, or the connection log — and it is
 * IDEMPOTENT: run it twice, the second run reports 0 changes.
 *
 * The 6 legacy G4 routes that verify via Client.webhookSecret (no &conn=)
 * are UNTOUCHED by design: they don't read WebhookEndpoint at all, so the
 * refresh can't affect them.
 *
 * Evidence: appends a concise run summary to .d13a-refresh-evidence.txt
 * (gitignored scratch, same convention as .fx-evidence.txt).
 */
import { readFileSync, appendFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import { refreshWebhookInboundUrls, resolveWebhookBase, RefreshWebhookUrlsResult } from "../src/lib/integrations";

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
    /* .env absent → the function's own env fallbacks still apply */
  }
}

function fmt(r: RefreshWebhookUrlsResult): string[] {
  const lines: string[] = [
    `REFRESH WEBHOOK INBOUND URL — ${new Date().toISOString()}`,
    `base = ${r.base} (source: ${r.source}${r.baseIsLoopback ? " — LOOPBACK: external providers CANNOT reach this" : ""})`,
  ];
  for (const row of r.rows) {
    lines.push(`  [${row.active ? "active" : "revoked "}] ${row.platform}/${row.label} ${row.changed ? "(updated)" : "(unchanged)"}`);
    lines.push(`      was: ${row.before}`);
    if (row.changed) lines.push(`      now: ${row.after}`);
  }
  lines.push(`RESULT: updated=${r.updated} unchanged=${r.unchanged} (total ${r.rows.length})`);
  if (r.baseIsLoopback) {
    lines.push(`NOTE: ${r.updated} row(s) rewritten but the base is still loopback — set PUBLIC_BASE_URL in .env (the live tunnel host) and re-run.`);
  }
  return lines;
}

async function main() {
  loadDotEnv();
  // An explicit base can be injected for testing without touching .env:
  //   tsx scripts/refresh-webhook-urls.ts <explicit-base-url>
  const explicit = process.argv[2];
  const res = await refreshWebhookInboundUrls(prisma, explicit ? { explicitBase: explicit } : {});

  const lines = fmt(res);
  for (const l of lines) console.log(l);

  // Evidence scratch (gitignored): the run log is the idempotency record —
  // run 1 shows N updated / 0 unchanged, run 2 shows 0 updated / N unchanged.
  try {
    appendFileSync(".d13a-refresh-evidence.txt", lines.join("\n") + "\n\n", "utf8");
  } catch {
    /* evidence scratch is best-effort; the stdout above is the record */
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("refresh-webhook-urls FAILED:", e);
  process.exit(1);
});
