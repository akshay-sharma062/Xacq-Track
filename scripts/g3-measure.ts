/**
 * G3 prep — live-traffic measurement (READ-ONLY; no DB writes, no Meta calls).
 *
 * Two honest numbers, per client:
 *   1. ad_id/UTM CARRY RATE (PRD Phase-1 gate "≥95% of landing-page leads
 *      carry ad_id/UTM"): counts landing-page TOUCHPOINTs (+ Leads that
 *      own at least one such touchpoint) that landed with adId non-null OR
 *      any UTM present. The ≥95% gate is MET ONLY on ≥20 live clicks;
 *      below that the status is "AWAITING LIVE TRAFFIC (<20 clicks)" — 0
 *      rows is the valid pre-G3 state, never MET, never a fake number.
 *   2. EMQ≥7 proof status (PRD Phase-3): counts Purchase OutboundEvents
 *      with a Meta-REPORTED event_match_quality (emqFromMeta=true,
 *      metaEmq verbatim) and reports whether ANY reaches ≥7. No rows →
 *      AWAITING, not claimed.
 *
 * Run NOW = 0/AWAITING; re-run AFTER the PO's clicks land to get the real
 * gate numbers. The CAPI re-run (letting Purchase events hit Meta) is the
 * PO's step 4.
 *
 * Run: pnpm g3:measure   (or: tsx scripts/g3-measure.ts)
 */
import { PrismaClient } from "@prisma/client";

const CLIENTS = [
  "cl_upcurvv",
  "cl_cardgenius-2",
  "cl_abhishek-pal-fml",
  "cl_fml-x-abhishek-pal",
  "cl_fml-new",
  "cl_the-job-workshop-ad-account",
  "cl_piyush-ahuja",
] as const;

const GATE = 0.95;
const MIN_CLICKS = 20;

async function main() {
  // Repo pattern (g8-replay / fx-backfill): plain client reads DATABASE_URL
  // from .env (file:./dev.db, relative to the schema dir = prisma/dev.db).
  const prisma = new PrismaClient();
  const names: Record<string, string> = {};
  const clRows = await prisma.client.findMany({ select: { id: true, name: true } });
  for (const c of clRows) names[c.id] = c.name ?? "";

  console.log("G3 MEASURE — read-only, " + new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC");
  console.log("Gate: ad_id/UTM carry ≥95% on ≥20 live clicks · EMQ≥7 on a Meta-reported Purchase");
  console.log("");
  console.log("| Client | ad_id-TPs | UTM-TPs | covered TP | all TP | carry % | Leads w/ ad_id/UTM | leads | verdict |");
  console.log("|---|---|---|---|---|---|---|---|---|");

  for (const clientId of CLIENTS) {
    const tps = await prisma.touchpoint.findMany({
      where: { clientId },
      select: { adId: true, utmSource: true, utmMedium: true, utmCampaign: true, utmContent: true, utmTerm: true, leadId: true },
    });
    const allTp = tps.length;
    const withAd = tps.filter((t) => t.adId != null && String(t.adId).trim() !== "").length;
    const withUtm = tps.filter((t) =>
      [t.utmSource, t.utmMedium, t.utmCampaign, t.utmContent, t.utmTerm].some((u) => u != null && String(u).trim() !== "")
    ).length;
    const covered = tps.filter((t) => (t.adId != null && String(t.adId).trim() !== "") ||
      [t.utmSource, t.utmMedium, t.utmCampaign, t.utmContent, t.utmTerm].some((u) => u != null && String(u).trim() !== "")
    ).length;
    // Leads that OWN a qualifying touchpoint (attribution rides the touchpoint,
    // not a Lead column — Lead.adId does not exist by design).
    const leadsWith = new Set(
      tps.filter((t) => t.leadId && ((t.adId != null && String(t.adId).trim() !== "") ||
        [t.utmSource, t.utmMedium, t.utmCampaign, t.utmContent, t.utmTerm].some((u) => u != null && String(u).trim() !== "")))
        .map((t) => t.leadId!)
    ).size;
    const leadTotal = await prisma.lead.count({ where: { clientId } });

    const rate = allTp > 0 ? covered / allTp : null;
    const verdict =
      allTp === 0
        ? "AWAITING LIVE TRAFFIC (0 clicks)"
        : covered === 0 && allTp > 0
          ? `NO ad_id/UTM carried (${allTp} clicks) — fix Meta ad URLs (audit)`
          : allTp < MIN_CLICKS
            ? `AWAITING LIVE TRAFFIC (<${MIN_CLICKS} clicks; ${covered}/${allTp} carried)`
            : rate! >= GATE
              ? "MET (≥95% on ≥20 live clicks)"
              : `BELOW GATE (${(100 * rate!).toFixed(1)}% < 95% on ${allTp} clicks)`;

    console.log(
      `| ${clientId} (${names[clientId] ?? "—"}) | ${withAd} | ${withUtm} | ${covered} | ${allTp} | ${rate == null ? "—" : (100 * rate).toFixed(1) + "%"} | ${leadsWith} | ${leadTotal} | ${verdict} |`
    );
  }

  // EMQ≥7 proof: Purchase events with a Meta-REPORTED event_match_quality.
  console.log("");
  console.log("EMQ≥7 proof (Meta-reported EMQ on Purchase):");
  let anySeven = false;
  let anyReported = false;
  for (const clientId of CLIENTS) {
    const rows = await prisma.outboundEvent.findMany({
      where: { clientId, type: "Purchase", emqFromMeta: true, metaEmq: { not: null } },
      select: { metaEmq: true, matchQuality: true, metaAckId: true },
    });
    if (rows.length === 0) continue;
    anyReported = true;
    const seven = rows.filter((r) => (r.matchQuality ?? 0) >= 7);
    if (seven.length > 0) anySeven = true;
    const sample = rows.slice(0, 3).map((r) => `ack=${r.metaAckId ?? "—"} emq=${r.metaEmq}`).join("; ");
    console.log(`  ${clientId}: ${rows.length} Purchase(s) with Meta-reported EMQ · ${seven.length} reach ≥7 · e.g. ${sample}`);
  }
  if (!anyReported) {
    console.log("  (none) — no Purchase event yet carries a Meta-reported event_match_quality.");
  }
  console.log(
    `EMQ≥7 status: ${anySeven ? "MET — a Meta-reported Purchase EMQ ≥ 7 exists" : anyReported ? "REPORTED but BELOW 7" : "AWAITING LIVE TRAFFIC (no Meta-reported EMQ yet; not claimed)"}`
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("G3 MEASURE ERROR:", e?.message ?? e);
  process.exitCode = 1;
});
