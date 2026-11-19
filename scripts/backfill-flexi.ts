/**
 * D-19b — one-off BACKFILL of the broken FlexiFunnels junk leads.
 *
 * The pre-D-19 flexifunnelsAdapter read `p.customer?.phone` / `p.action` —
 * both `undefined` on FlexiFunnels' REAL flat optin payload — so every
 * optin parsed as `payment_failed` with NO identity and created a
 * source-unknown `Hot` lead (name/phone/email/city all null). Those junk
 * leads exist for cl_abhishek-pal-fml. The full rawPayload was preserved on
 * the WebhookLog row (spec 4), so we can re-run it through the NEW adapter
 * and give the lead its real identity + the structured `meta` — without
 * creating any new lead and without deleting anything.
 *
 * Matching (1:1, honest): a junk lead's flexi event and its WebhookLog row
 * fire in the same request (lead.createdAt ≈ log.receivedAt to the
 * sub-second). We sort both by time and greedily pair each junk lead to its
 * nearest UNUSED backfillable log within a small window, so two leads never
 * share one log. A log is "backfillable" only when the NEW adapter parses it
 * to a LEAD-CAPTURE record (`registered` — the flat optin shape) that carries
 * an identity (phone or email). Synthetic payment-proof payloads (the D-18
 * `{action, customer}` test fixtures, G4 replays) parse to a payment record
 * and are NOT backfillable: their leads stay source-unknown (honest), never
 * retrofitted with a test-fixture identity like d18proof@example.com.
 *
 * Additive + idempotent: only leads with phone=null AND email=null qualify,
 * so a second run finds 0 qualifying leads and changes 0 rows. No rows are
 * deleted; no leads are created. Reports before/after.
 *
 * Run: `pnpm backfill:flexi` (or `tsx scripts/backfill-flexi.ts [--dry] [clientId]`).
 *
 * TESTABLE: the matching core is exported (`candidatesFromFlexiLogs`,
 * `matchFlexiBackfill`, `runFlexiBackfill`) so test/d19b.test.ts drives it
 * against a freshDb — no CLI, no hard-coded Prisma client. The CLI below
 * only runs when THIS file is the entry point (`pnpm backfill:flexi`),
 * guarded by an argv check so importing the module in tests never fires it.
 * Writes ZERO Meta pull rows.
 */
import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";
import { adapterFor } from "../src/lib/adapters";
import { normalisePhone, normaliseEmail } from "../src/lib/identity";

/** A backfillable candidate: one stored FlexiFunnels log that the NEW adapter
 *  re-parses to a LEAD-CAPTURE record carrying an identity. */
export interface FlexiCandidate {
  logId: string;
  logAt: Date;
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  city?: string | null;
  meta?: Record<string, unknown>;
}

/** Re-run each stored flexi WebhookLog through the NEW adapter; keep only
 *  LEAD-CAPTURE records (`registered`) that carry an identity (phone/email).
 *  Payment-family / no-identity logs are NOT backfillable (their leads stay
 *  source-unknown, honestly). Pure — no DB. */
export function candidatesFromFlexiLogs(
  logs: { id: string; receivedAt: Date; rawPayload: string }[]
): FlexiCandidate[] {
  const parse = adapterFor("flexifunnels").parse;
  const out: FlexiCandidate[] = [];
  for (const log of logs) {
    let recs: ReturnType<typeof parse>;
    try {
      recs = parse(JSON.parse(log.rawPayload));
    } catch {
      continue; // unparseable body — skip, never invent a payload
    }
    const rec = recs[0];
    if (!rec || rec.type !== "registered") continue; // lead-capture only
    const phone = normalisePhone(rec.phone ?? null);
    const email = normaliseEmail(rec.email ?? null);
    if (!phone && !email) continue; // no identity to grant → not backfillable
    out.push({
      logId: log.id,
      logAt: log.receivedAt,
      phone,
      email,
      name: rec.name ?? null,
      city: rec.city ?? null,
      meta: rec.meta,
    });
  }
  return out;
}

export interface FlexiMatch {
  leadId: string;
  leadCreatedAt: Date;
  candidate: FlexiCandidate;
  deltaMs: number;
}

/** Greedy 1:1 matching: each junk lead → nearest UNUSED backfillable log
 *  within the window. Two leads NEVER share one log (the no-duplicate
 *  guarantee). Pure — no DB; a used log is tracked internally, so the
 *  input candidates are never mutated. */
export function matchFlexiBackfill(
  candidates: FlexiCandidate[],
  leads: { id: string; createdAt: Date }[],
  windowMs = 60_000
): { matches: FlexiMatch[]; matched: number; skippedNoPayload: number } {
  const used = new Set<string>();
  const matches: FlexiMatch[] = [];
  let skippedNoPayload = 0;
  for (const lead of leads) {
    let best: FlexiCandidate | null = null;
    let bestD = Infinity;
    for (const c of candidates) {
      if (used.has(c.logId)) continue;
      const d = Math.abs(c.logAt.getTime() - lead.createdAt.getTime());
      if (d > windowMs) continue;
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
    if (!best) {
      skippedNoPayload++; // genuinely no stored payload to match → stays source-unknown
      continue;
    }
    used.add(best.logId);
    matches.push({ leadId: lead.id, leadCreatedAt: lead.createdAt, candidate: best, deltaMs: bestD });
  }
  return { matches, matched: matches.length, skippedNoPayload };
}

export interface FlexiBackfillResult {
  client: string;
  dry: boolean;
  logCount: number;
  candidateCount: number;
  junkFound: number;
  matched: number;
  updatedLeads: number;
  eventsAttached: number;
  skippedNoPayload: number;
  stillNullIdent: number;
  totalLeads: number;
}

/** The full backfill against an injected Prisma client (so tests use
 *  freshDb). Additive + idempotent: only phone=null AND email=null leads
 *  qualify, so a 2nd run finds 0 qualifying leads and changes 0 rows. No
 *  row is deleted; no lead is created. */
export async function runFlexiBackfill(
  prisma: PrismaClient,
  opts: { clientId?: string; dry?: boolean } = {}
): Promise<FlexiBackfillResult> {
  const clientId = opts.clientId ?? "cl_abhishek-pal-fml";
  const dry = opts.dry ?? false;

  // 1) Every flexifunnels WebhookLog for the client (time order).
  const logs = await prisma.webhookLog.findMany({
    where: { clientId, platform: "flexifunnels" },
    orderBy: { receivedAt: "asc" },
    select: { id: true, receivedAt: true, rawPayload: true },
  });
  const candidates = candidatesFromFlexiLogs(logs);

  // 2) The junk leads: phone=null AND email=null (the source-unknown set).
  const junk = await prisma.lead.findMany({
    where: { clientId, phone: null, email: null },
    orderBy: { createdAt: "asc" },
  });
  const leadSeeds = junk.map((l) => ({ id: l.id, createdAt: l.createdAt }));
  const { matches, matched, skippedNoPayload } = matchFlexiBackfill(candidates, leadSeeds);

  // 3) Apply the matches (skipped in --dry).
  let updatedLeads = 0;
  let eventsAttached = 0;
  for (const m of matches) {
    const c = m.candidate;
    const metaPayload = c.meta ? { meta: c.meta } : {};
    if (dry) continue;

    const lead = await prisma.lead.findUnique({
      where: { id: m.leadId },
      select: {
        name: true, phone: true, phoneNormalized: true,
        email: true, emailNormalized: true, city: true,
      },
    });
    if (!lead) continue;
    // Additive UPDATE of identity fields only (never delete; no new lead).
    await prisma.lead.update({
      where: { id: m.leadId },
      data: {
        name: c.name ?? lead.name,
        phone: c.phone ?? lead.phone,
        phoneNormalized: c.phone ?? lead.phoneNormalized,
        email: c.email ?? lead.email,
        emailNormalized: c.email ?? lead.emailNormalized,
        city: c.city ?? lead.city,
        // now identified → no longer "source unknown" (the ticket's rule).
        sourceUnknown: false,
      },
    });
    updatedLeads++;

    // Attach `meta` to this lead's flexi event(s): merge into the existing
    // record-level rawPayload (keep its ad/gateway keys) + set the provenance
    // webhookLogId link. Idempotent — a re-run finds the lead already has
    // phone/email, so it is never re-matched.
    const events = await prisma.event.findMany({
      where: { leadId: m.leadId, sourcePlatform: "flexifunnels" },
      select: { id: true, rawPayload: true, webhookLogId: true },
    });
    for (const ev of events) {
      let base: Record<string, unknown> = {};
      try {
        base = JSON.parse(ev.rawPayload);
      } catch {
        base = {};
      }
      const merged = { ...base, ...metaPayload, webhookLogId: ev.webhookLogId ?? c.logId };
      await prisma.event.update({
        where: { id: ev.id },
        data: { rawPayload: JSON.stringify(merged), webhookLogId: ev.webhookLogId ?? c.logId },
      });
      eventsAttached++;
    }
  }

  // 4) Idempotency proof: re-count the still-qualifying leads.
  const stillNullIdent = await prisma.lead.count({ where: { clientId, phone: null, email: null } });
  const totalLeads = await prisma.lead.count({ where: { clientId } });

  return {
    client: clientId,
    dry,
    logCount: logs.length,
    candidateCount: candidates.length,
    junkFound: junk.length,
    matched,
    updatedLeads,
    eventsAttached,
    skippedNoPayload,
    stillNullIdent,
    totalLeads,
  };
}

// ---------------------------------------------------------------------------
// CLI — only when this file is the entry point (guarded so a test import
// never fires it).
// ---------------------------------------------------------------------------
function fmt(r: FlexiBackfillResult): string[] {
  return [
    `D-19b backfill-flexi (flexifunnels, lead-capture optins only)`,
    `  client           = ${r.client}${r.dry ? "  [DRY RUN — no writes]" : ""}`,
    `  flexi logs       = ${r.logCount} (backfillable lead-capture = ${r.candidateCount})`,
    `  junk leads found = ${r.junkFound}`,
    `  matched          = ${r.matched}`,
    `  updated leads    = ${r.updatedLeads}`,
    `  events w/ meta   = ${r.eventsAttached}`,
    `  no-payload left  = ${r.skippedNoPayload} (stay source-unknown, honest)`,
    `  still null-ident = ${r.stillNullIdent} of ${r.totalLeads} total leads (second run should show 0 changed)`,
  ];
}

async function main() {
  const dry = process.argv.includes("--dry");
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const clientId = args[0] ?? "cl_abhishek-pal-fml";
  const prisma = new PrismaClient();
  try {
    const r = await runFlexiBackfill(prisma, { dry, clientId });
    for (const line of fmt(r)) console.log(line);
  } finally {
    await prisma.$disconnect();
  }
}

/** True only when this file is the process entry point (so `pnpm
 *  backfill:flexi` runs the CLI but `import { ... }` in tests does not). */
function isEntry(): boolean {
  if (typeof process === "undefined" || !process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((e) => {
    console.error("backfill-flexi failed:", e);
    process.exit(1);
  });
}
