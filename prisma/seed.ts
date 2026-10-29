/**
 * `pnpm db:seed` — load the demo dataset (fake data only, spec rule 8).
 *
 * The pure "data" half lives in `src/lib/seed.ts` (`buildSeed()`); this file is
 * the Prisma-writing half: it takes that bundle and upserts every row so the
 * 14 screens + every report show real numbers on a fresh `pnpm dev`.
 *
 * Idempotent: wipes and re-creates, in dependency order, so re-running is safe.
 *
 * Usage: `pnpm db:seed` (reads DATABASE_URL from .env; defaults to
 * `file:./dev.db` next to this file).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { buildSeed } from "../src/lib/seed";

const here = dirname(fileURLToPath(import.meta.url));

function ensureDatabaseUrl(): void {
  let url = process.env.DATABASE_URL;
  if (!url) {
    const envFile = join(here, "..", ".env");
    if (existsSync(envFile)) {
      const m = readFileSync(envFile, "utf8").match(/^DATABASE_URL="?([^"\n]+)"?/m);
      if (m) url = m[1];
    }
  }
  url ??= "file:./dev.db";
  process.env.DATABASE_URL = url;
}

async function main(): Promise<void> {
  ensureDatabaseUrl();
  // Resolve a relative SQLite path against this file's directory so `file:./dev.db`
  // lands in prisma/ regardless of cwd (migrate.ts writes it here too).
  if (process.env.DATABASE_URL?.startsWith("file:")) {
    const rel = process.env.DATABASE_URL.replace(/^file:/, "");
    if (!rel.startsWith(":memory:") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel)) {
      process.env.DATABASE_URL = `file:${join(here, rel)}`;
    }
  }
  console.log(`DATABASE_URL = ${process.env.DATABASE_URL}`);

  const prisma = new PrismaClient();
  const bundle = buildSeed();

  // Make sure the schema exists even if the user skipped `db:migrate`.
  try {
    await prisma.user.count();
  } catch {
    console.log("Schema not found — running `prisma db push` first…");
    execSync("npx prisma db push --schema " + JSON.stringify(join(here, "schema.prisma")) + " --accept-data-loss", {
      stdio: "inherit",
    });
  }

  // ------------------------------------------------------------------------
  // Wipe (children before parents). SQLite FKs are off by default in Prisma,
  // so order is belt-and-braces for Postgres.
  // ------------------------------------------------------------------------
  await prisma.$transaction([
    prisma.formFieldMapping.deleteMany(),
    prisma.metaLeadForm.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.outboundEvent.deleteMany(),
    prisma.webhookLog.deleteMany(),
    prisma.call.deleteMany(),
    prisma.note.deleteMany(),
    prisma.task.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.event.deleteMany(),
    prisma.touchpoint.deleteMany(),
    prisma.spend.deleteMany(),
    prisma.creative.deleteMany(),
    prisma.ad.deleteMany(),
    prisma.adSet.deleteMany(),
    prisma.adCampaign.deleteMany(),
    prisma.adAccount.deleteMany(),
    prisma.lead.deleteMany(),
    prisma.visitor.deleteMany(),
    prisma.attributionRule.deleteMany(),
    prisma.reportConfig.deleteMany(),
    prisma.funnel.deleteMany(),
    prisma.client.deleteMany(),
    prisma.user.deleteMany(),
    prisma.workspace.deleteMany(),
  ]);

  const t0 = Date.now();

  // Tenancy
  for (const w of bundle.workspaces) await prisma.workspace.create({ data: w });
  for (const u of bundle.users) await prisma.user.create({ data: u });
  for (const c of bundle.clients) await prisma.client.create({ data: c });

  // Funnels + ad entities
  for (const f of bundle.funnels) await prisma.funnel.create({ data: f });
  for (const a of bundle.adAccounts) await prisma.adAccount.create({ data: a });
  for (const c of bundle.adCampaigns) await prisma.adCampaign.create({ data: c });
  for (const s of bundle.adSets) await prisma.adSet.create({ data: s });
  for (const a of bundle.ads) await prisma.ad.create({ data: a });
  for (const cr of bundle.creatives) await prisma.creative.create({ data: cr });

  // Visitors, then leads
  for (const v of bundle.visitors) await prisma.visitor.create({ data: v });
  for (const l of bundle.leads) await prisma.lead.create({ data: l });

  // Touchpoints (need adRefId -> Ad.metaId, visitorId, leadId)
  for (const t of bundle.touchpoints) await prisma.touchpoint.create({ data: t });

  // Webhooks (events reference webhookLogId)
  for (const w of bundle.webhooks) await prisma.webhookLog.create({ data: w });

  // Events
  for (const e of bundle.events) await prisma.event.create({ data: e });

  // Payments
  for (const p of bundle.payments) await prisma.payment.create({ data: p });

  // Follow-ups
  for (const t of bundle.tasks) await prisma.task.create({ data: t });
  for (const n of bundle.notes) await prisma.note.create({ data: n });
  for (const c of bundle.calls) await prisma.call.create({ data: c });

  // CAPI outbound. Normalise `dedupKey`: the fixture omits it for oe_001..006,
  // but the model field is required + unique — derive a stable one from the id.
  for (const o of bundle.outbound) {
    // `dedupKey` is required+unique on the model but the fixture omits it for
    // oe_001..006 — derive a stable one from the row id.
    const dedupKey = o.dedupKey ?? `seed:${o.id}`;
    const row = { ...o, dedupKey } as unknown as Parameters<typeof prisma.outboundEvent.create>[0]["data"];
    await prisma.outboundEvent.create({ data: row });
  }

  // Audit
  for (const a of bundle.audit) await prisma.auditLog.create({ data: a });

  // Meta Instant Form plumbing
  for (const m of bundle.metaForms) await prisma.metaLeadForm.create({ data: m });
  for (const m of bundle.fieldMappings) await prisma.formFieldMapping.create({ data: m });

  // Attribution + report config
  for (const r of bundle.attributionRules) await prisma.attributionRule.create({ data: r });
  for (const r of bundle.reportConfigs) await prisma.reportConfig.create({ data: r });

  // Spend — the big set (90 rows); bulk-insert.
  await prisma.spend.createMany({ data: bundle.spends });

  // ------------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------------
  const [leads, events, payments, capi, spend] = await Promise.all([
    prisma.lead.count(),
    prisma.event.count(),
    prisma.payment.count(),
    prisma.outboundEvent.count(),
    prisma.spend.count(),
  ]);
  const pretty = { leads, events, payments, capi, spend };
  console.log(`Seeded in ${Date.now() - t0}ms -> ${JSON.stringify(pretty)}`);
  console.log("Demo data ready. Run `pnpm dev` and open the app.");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
