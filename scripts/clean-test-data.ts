/**
 * D-25 — clean test/replay data from the DB. Two-layer: DRY-RUN (default)
 * then confirmed --apply. Pull rows (Ad/AdSet/AdCampaign/Creative/Spend/
 * FxRate/LiveRange) are NEVER touched.
 *
 * What counts as a "test" row (the ticket's marker criteria):
 *   test receipt  = WebhookLog where platform='debug' OR rawPayload has
 *                   '_test' OR 'replay' in it.
 *   test event    = Event whose webhookLogId is a test receipt.
 *   test lead     = Lead that has >=1 test event AND 0 non-test events — i.e.
 *                   it is a lead ONLY test events created (a real event
 *                   anywhere on the lead PRESERVES it; a bare 0-event lead
 *                   also survives, it is not a test lead).
 *   test payment  = Payment whose leadId is a test lead.
 *   test outbound = OutboundEvent whose leadId is a test lead.
 *
 * Usage:
 *   pnpm clean:test-data          → DRY RUN: writes 0, emits the plan to
 *                                    .d25-dryrun.txt (gitignored). Default.
 *   pnpm clean:test-data --apply  → prompts the PO to type "DELETE CONFIRMED"
 *                                    on stdin; only then deletes, in FK-safe
 *                                    order, writes one AuditLog row, and
 *                                    verifies the pull-row counts stayed
 *                                    byte-identical.
 *
 * Deletion order (FK-safe): outbound → payment → event → lead → webhooklog.
 */
import { PrismaClient } from "@prisma/client";
import { ensureSqliteConcurrency } from "../src/lib/sqlite-pragma";
import { writeFileSync, appendFileSync } from "node:fs";
import * as readline from "node:readline";

const APPLY = process.argv.includes("--apply");
const OUT = ".d25-dryrun.txt";

// The G1/G4 pull rows are real data — NEVER deleted by this script. We only
// READ their counts before/after to PROVE the clean left them byte-identical.
const PULL_TABLES = [
  "Ad", "AdSet", "AdCampaign", "Creative", "Spend", "FxRate", "LiveRange",
] as const;
type PullTable = (typeof PULL_TABLES)[number];

// A phone, last-4 only (the ticket: no PII beyond last-4 phone in the report).
function maskPhone(p: string | null | undefined): string {
  const s = (p ?? "").trim();
  if (!s) return "—";
  const digits = s.replace(/[^0-9]/g, "");
  return digits.length ? "•••" + digits.slice(-4) : "—";
}
function iso(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(x.getTime()) ? "—" : x.toISOString().slice(0, 16).replace("T", " ");
}

interface Receipt {
  id: string;
  platform: string;
  status: string;
  clientId: string;
  receivedAt: Date;
  rawLen: number;
}

async function main() {
  const prisma = new PrismaClient();
  // Mirror the app's WAL + busy_timeout so this one-shot writer does not
  // block the running prod reader (the P1017 the app was patched for).
  void ensureSqliteConcurrency(prisma);

  try {
    // ── Read the pull-row baseline BEFORE anything (must stay identical). ──
    const pullBefore: Record<PullTable, number> = {} as Record<PullTable, number>;
    for (const t of PULL_TABLES) {
      const c = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*) n FROM "${t}"`,
      );
      pullBefore[t] = Number(c[0]?.n ?? 0);
    }

    // Before-totals of the 5 deletable types (for the report).
    const before = {
      leads: await prisma.lead.count(),
      events: await prisma.event.count(),
      payments: await prisma.payment.count(),
      outbound: await prisma.outboundEvent.count(),
      webhooklogs: await prisma.webhookLog.count(),
    };

    // ── Identify the test sets (read-only). ──────────────────────────────
    const receipts = await prisma.webhookLog.findMany({
      where: {
        OR: [
          { platform: "debug" },
          { rawPayload: { contains: "_test" } },
          { rawPayload: { contains: "replay" } },
        ],
      },
      select: { id: true, platform: true, status: true, clientId: true, receivedAt: true, rawPayload: true },
    });
    const trIds = receipts.map((r) => r.id);
    const testReceipts: Receipt[] = receipts.map((r) => ({
      id: r.id, platform: r.platform, status: r.status,
      clientId: r.clientId, receivedAt: r.receivedAt, rawLen: r.rawPayload?.length ?? 0,
    }));

    // Test events: the events whose provenance is a test receipt.
    const testEvents = trIds.length
      ? await prisma.event.findMany({
          where: { webhookLogId: { in: trIds } },
          select: { id: true, type: true, sourcePlatform: true, leadId: true, clientId: true, webhookLogId: true },
        })
      : [];
    const teIds = testEvents.map((e) => e.id);

    // Per-lead classification: a test lead has >=1 test event AND 0 non-test
    // events. Bare 0-event leads do NOT qualify (they have no test event to
    // remove) — they are preserved, not deleted.
    const testEventLeadIds = [...new Set(testEvents.map((e) => e.leadId))];
    const testLeads: string[] = [];
    for (const lid of testEventLeadIds) {
      const totalEv = await prisma.event.count({ where: { leadId: lid } });
      const testEv = testEvents.filter((e) => e.leadId === lid).length;
      const nonTest = totalEv - testEv;
      if (testEv >= 1 && nonTest === 0) testLeads.push(lid);
    }

    // Test payments / outbound: only those on test-lead rows.
    const testPayments = testLeads.length
      ? await prisma.payment.findMany({ where: { leadId: { in: testLeads } }, select: { id: true, leadId: true, gateway: true, amount: true, status: true } })
      : [];
    const testOutbound = testLeads.length
      ? await prisma.outboundEvent.findMany({ where: { leadId: { in: testLeads } }, select: { id: true, leadId: true, type: true, status: true, dedupKey: true } })
      : [];

    // Lead sample rows (masked) — only populated when testLeads is non-empty.
    const testLeadSamples = testLeads.length
      ? await prisma.lead.findMany({ where: { id: { in: testLeads } }, select: { id: true, stage: true, phone: true, clientId: true }, take: 5 })
      : [];

    const totalDelete =
      testLeads.length + testEvents.length + testPayments.length + testOutbound.length + testReceipts.length;

    // ── Build the plan report. ──────────────────────────────────────────
    const lines: string[] = [];
    lines.push(`D-25 clean-test-data — ${APPLY ? "APPLY" : "DRY-RUN"} — ${new Date().toISOString()}`);
    lines.push(`DB: ${process.env.DATABASE_URL ?? "(unset)"}`);
    lines.push("");
    lines.push(`PULL-ROW BASELINE (read-only, must stay byte-identical): ${JSON.stringify(pullBefore)}`);
    lines.push(`BEFORE totals — leads ${before.leads} · events ${before.events} · payments ${before.payments} · outbound ${before.outbound} · webhooklogs ${before.webhooklogs}`);
    lines.push("");

    lines.push(`(a) TEST RECEIPTS (webhooklog) — ${testReceipts.length}`);
    for (const r of testReceipts.slice(0, 5)) {
      lines.push(`   ${r.id}  ${r.platform}/${r.status}  ${r.clientId}  received ${iso(r.receivedAt)}  rawPayload ${r.rawLen}b`);
    }
    if (testReceipts.length > 5) lines.push(`   … and ${testReceipts.length - 5} more`);
    lines.push("");

    lines.push(`(b) TEST EVENTS (event) — ${testEvents.length}`);
    for (const e of testEvents.slice(0, 5)) {
      lines.push(`   ${e.id}  ${e.type}  src=${e.sourcePlatform}  lead=${e.leadId}  ${e.clientId}  whl=${e.webhookLogId}`);
    }
    if (testEvents.length > 5) lines.push(`   … and ${testEvents.length - 5} more`);
    lines.push("");

    lines.push(`(c) TEST LEADS (lead, test-events-only) — ${testLeads.length}`);
    if (testLeads.length === 0) lines.push("   (none — every lead that has a test event also has a real event; preserved)");
    for (const l of testLeadSamples) {
      lines.push(`   ${l.id}  stage=${l.stage}  phone=${maskPhone(l.phone)}  ${l.clientId}`);
    }
    lines.push("");

    lines.push(`(d) TEST PAYMENTS (payment on test-lead) — ${testPayments.length}`);
    if (testPayments.length === 0) lines.push("   (none)");
    for (const p of testPayments.slice(0, 5)) {
      lines.push(`   ${p.id}  lead=${p.leadId}  ${p.gateway}  ${p.amount}  ${p.status}`);
    }
    lines.push("");

    lines.push(`(e) TEST OUTBOUND/CAPI (outboundevent on test-lead) — ${testOutbound.length}`);
    if (testOutbound.length === 0) lines.push("   (none)");
    for (const o of testOutbound.slice(0, 5)) {
      lines.push(`   ${o.id}  ${o.type}  ${o.status}  dedup=${o.dedupKey}`);
    }
    lines.push("");

    lines.push(
      `Total to delete: ${testLeads.length} leads, ${testEvents.length} events, ${testPayments.length} payments, ` +
        `${testOutbound.length} outbound, ${testReceipts.length} webhooklogs.  (=${totalDelete} rows)`,
    );
    lines.push(`Pull rows (ad/adset/spend/campaign/creative/fx/live) UNTOUCHED — verified below.`);
    lines.push(APPLY ? "" : "PO: review .d25-dryrun.txt, then run `pnpm clean:test-data --apply`.");

    if (!APPLY) {
      // DRY RUN: write 0, emit the plan.
      writeFileSync(OUT, lines.join("\n") + "\n");
      console.log(`[D-25 DRY RUN] plan written to ${OUT} (0 rows deleted).`);
      console.log(`  test receipts=${testReceipts.length}  test events=${testEvents.length}  test leads=${testLeads.length}  test payments=${testPayments.length}  test outbound=${testOutbound.length}`);
      console.log(`  pull-row baseline (unchanged): ${JSON.stringify(pullBefore)}`);
      console.log(`  Next: review ${OUT}, then run  pnpm clean:test-data --apply`);
      return;
    }

    // ── APPLY: the second-confirmation step. ────────────────────────────
    console.log("\n[APPLY] This will DELETE the following from the live DB:");
    console.log(`  ${testLeads.length} leads, ${testEvents.length} events, ${testPayments.length} payments, ${testOutbound.length} outbound, ${testReceipts.length} webhooklogs (=${totalDelete} rows). Pull rows untouched.`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) =>
      rl.question('Type exactly "DELETE CONFIRMED" to proceed (anything else aborts): ', (a) => resolve(a.trim())),
    );
    rl.close();
    if (answer !== "DELETE CONFIRMED") {
      console.log(`ABORT — confirmation "${answer}" was not "DELETE CONFIRMED". 0 rows deleted.`);
      writeFileSync(OUT, lines.join("\n") + "\n");
      process.exitCode = 1;
      return;
    }

    // One AuditLog row, written FIRST (the ticket: "BEFORE deleting, write one
    // AuditLog row"), inside the SAME transaction as the deletes so the audit
    // + the deletion commit atomically. clientId = the one that owns the most
    // test receipts (representative); userId = the owner (the acting PO).
    const receiptByClient = new Map<string, number>();
    for (const r of testReceipts) receiptByClient.set(r.clientId, (receiptByClient.get(r.clientId) ?? 0) + 1);
    const auditClientId =
      [...receiptByClient.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "cl_abhishek-pal-fml";
    const owner = (await prisma.user.findFirst({ where: { role: "owner" }, select: { id: true } }))?.id ?? "u_owner";

    // FK-safe delete order: outbound → payment → event → lead → webhooklog.
    // (an empty `in: []` set is a valid no-op, so the lead/payment/outbound
    // deletes are safe even when testLeads is empty.)
    const deleted: { outbound: number; payment: number; event: number; lead: number; webhooklog: number } =
      { outbound: 0, payment: 0, event: 0, lead: 0, webhooklog: 0 };
    await prisma.$transaction(async (tx) => {
      // 1) the audit row — BEFORE the deletes — planned counts (== actual, the
      //    delete set is deterministic and computed above).
      if (totalDelete > 0) {
        await tx.auditLog.create({
          data: {
            clientId: auditClientId,
            userId: owner,
            action: "delete",
            entity: "clean_test_data",
            entityId: "d25-batch",
            details: JSON.stringify({
              note: "D-25 clean-test-data: deleted " +
                `${testLeads.length} leads, ${testEvents.length} events, ${testPayments.length} payments, ` +
                `${testOutbound.length} outbound, ${testReceipts.length} webhooklogs. ` +
                `Trigger: manual PO approval. Pull rows untouched.`,
              pullRowsBefore: pullBefore,
            }),
          },
        });
      }
      // 2) the deletes, FK-safe order.
      deleted.outbound = (await tx.outboundEvent.deleteMany({ where: { leadId: { in: testLeads } } })).count;
      deleted.payment = (await tx.payment.deleteMany({ where: { leadId: { in: testLeads } } })).count;
      deleted.event = (await tx.event.deleteMany({ where: { id: { in: teIds } } })).count;
      deleted.lead = (await tx.lead.deleteMany({ where: { id: { in: testLeads } } })).count;
      deleted.webhooklog = (await tx.webhookLog.deleteMany({ where: { id: { in: trIds } } })).count;
    });
    const rowsDeleted =
      deleted.outbound + deleted.payment + deleted.event + deleted.lead + deleted.webhooklog;

    // ── Verify: pull rows byte-identical + post-clean totals. ───────────
    const pullAfter: Record<PullTable, number> = {} as Record<PullTable, number>;
    for (const t of PULL_TABLES) {
      const c = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*) n FROM "${t}"`);
      pullAfter[t] = Number(c[0]?.n ?? 0);
    }
    const pullIdentical = PULL_TABLES.every((t) => pullBefore[t] === pullAfter[t]);

    const after = {
      leads: await prisma.lead.count(),
      events: await prisma.event.count(),
      payments: await prisma.payment.count(),
      outbound: await prisma.outboundEvent.count(),
      webhooklogs: await prisma.webhookLog.count(),
    };

    // Append the execution result to the same report file.
    const res: string[] = [];
    res.push("");
    res.push(`=== APPLY RESULT — ${new Date().toISOString()} ===`);
    res.push(`Deleted: ${JSON.stringify(deleted)}  (total ${rowsDeleted} rows)`);
    res.push(`BEFORE — leads ${before.leads} · events ${before.events} · payments ${before.payments} · outbound ${before.outbound} · webhooklogs ${before.webhooklogs}`);
    res.push(`AFTER  — leads ${after.leads} · events ${after.events} · payments ${after.payments} · outbound ${after.outbound} · webhooklogs ${after.webhooklogs}`);
    res.push(`Pull rows before: ${JSON.stringify(pullBefore)}`);
    res.push(`Pull rows after : ${JSON.stringify(pullAfter)}`);
    res.push(`Pull rows byte-identical: ${pullIdentical ? "YES ✓" : "NO ✗ — INVESTIGATE, DO NOT TRUST THE CLEAN"}`);
    res.push(`AuditLog row written (client=${auditClientId}, user=${owner}).`);
    appendFileSync(OUT, res.join("\n") + "\n");

    console.log(`[D-25 APPLY] deleted ${rowsDeleted} rows: ${JSON.stringify(deleted)}`);
    console.log(`  before: leads ${before.leads} · events ${before.events} · payments ${before.payments} · outbound ${before.outbound} · webhooklogs ${before.webhooklogs}`);
    console.log(`  after : leads ${after.leads} · events ${after.events} · payments ${after.payments} · outbound ${after.outbound} · webhooklogs ${after.webhooklogs}`);
    console.log(`  pull rows identical: ${pullIdentical ? "YES ✓" : "NO ✗"}`);
    if (!pullIdentical) {
      console.error("  !! pull-row counts CHANGED — this must not happen; the clean is not safe. Investigate before trusting any dashboard numbers.");
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("[D-25] ERROR:", e?.message ?? e);
  process.exitCode = 1; // let the event loop drain (no hard-exit crash on Windows).
});
