/**
 * Shared test DB helpers: a throwaway SQLite file + Prisma client, schema
 * applied via `prisma db push`. Each call gets its own temp file so test
 * files can run in parallel forks. No temp file is left behind.
 *
 * D-01/D-02 (2026-10-30): `freshDb()` now starts from the TENANCY BOOTSTRAP
 * (workspace + two Foremost Leads users + the cl_upcurvv client + the G1
 * ad-account link row) — the same rows `pnpm db:seed` writes. It NEVER writes
 * lead/event/spend fixture data: tests that need ad trees, spend series or
 * leads build their OWN fixtures (spec §8: replay tests use saved sample
 * payloads, not seed data). `freshDb({ seed: false })` gives a bare schema
 * (no tenancy rows at all) — used by fx-store-style tests.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { bootstrapInto } from "../src/lib/seed";

export interface TestDb {
  prisma: PrismaClient;
  close: () => Promise<void>;
}

export async function freshDb(opts: { seed?: boolean } = {}): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "xacqora-test-"));
  const file = join(dir, "test.db");
  const url = `file:${file}`;
  process.env.DATABASE_URL = url;

  // Apply the schema to this throwaway DB (fast; idempotent).
  execSync(
    "npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma",
    { stdio: "ignore", env: { ...process.env, DATABASE_URL: url } }
  );

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();
  // Default = the tenancy bootstrap (what `pnpm db:seed` produces). seed:false
  // = bare schema, zero rows (for fx-store-style tests that only need tables).
  if (opts.seed !== false) await bootstrapInto(prisma);

  return {
    prisma,
    close: async () => {
      await prisma.$disconnect();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/**
 * Fixture-own ad tree for report tests (spec §8): one ad account, three ad
 * sets of ads with the classic G1 shape — a converting video ad, a wasted
 * high-spend static ad, and a cheap retargeting ad — plus N days of daily
 * spend rows (INR, like the real Upcurvv-FML account). Deterministic ids so
 * assertions can reference them.
 */
export async function fixtureAdAccount(
  prisma: PrismaClient,
  clientId: string,
  opts: { days?: number; adAccountMetaId?: string } = {}
): Promise<{ adAccount: string; videoAd: string; staticAd: string; retargetAd: string }> {
  const days = opts.days ?? 35;
  const metaId = opts.adAccountMetaId ?? "act_4749960348632164"; // the G1 account
  // The bootstrap (or a real pull) may already have the link row; upsert it.
  await prisma.adAccount.upsert({
    where: { metaId },
    update: { clientId },
    create: { metaId, clientId, name: "Upcurvv-FML", currency: "INR" },
  });
  const acct = await prisma.adAccount.findUniqueOrThrow({ where: { metaId } });

  const CAM = "52548182104540";
  const SETS = ["52548182105001", "52548182105002", "52548182105003"];
  const [VIDEO, STATIC, RETARGET] = ["52548182104940", "52548182203140", "52548188579540"];
  const names: Record<string, string> = {
    [VIDEO]: "Video 1",
    [STATIC]: "Static 1",
    [RETARGET]: "Retarget 1",
  };

  // Campaign first: AdSet.campaignMetaId is an FK to AdCampaign.
  await prisma.adCampaign.upsert({
    where: { metaId: CAM },
    update: {},
    create: { metaId: CAM, adAccountId: acct.id, clientId, name: "campaign", status: "ACTIVE" },
  });
  for (const set of SETS) {
    await prisma.adSet.upsert({
      where: { metaId: set },
      update: {},
      create: { metaId: set, adAccountId: acct.id, campaignMetaId: CAM, clientId, name: "set", status: "ACTIVE" },
    });
  }
  const setFor: Record<string, string> = { [VIDEO]: SETS[0], [STATIC]: SETS[1], [RETARGET]: SETS[2] };
  for (const ad of [VIDEO, STATIC, RETARGET]) {
    await prisma.ad.upsert({
      where: { metaId: ad },
      update: {},
      create: { metaId: ad, adAccountId: acct.id, adSetMetaId: setFor[ad], clientId, name: names[ad], status: "ACTIVE" },
    });
    await prisma.creative.upsert({
      where: { id: `fx_cr_${ad}` },
      update: {},
      create: { id: `fx_cr_${ad}`, adMetaId: ad, type: ad === VIDEO ? "VIDEO" : "IMAGE", thumbnailUrl: `https://picsum.photos/seed/${ad}/160/90` },
    });
  }

  // Daily spend: INR account (rate 1:1), spread across the last `days` days.
  const prof: Record<string, { spend: number; conv: number }> = {
    [VIDEO]: { spend: 900, conv: 3 },    // converts
    [STATIC]: { spend: 500, conv: 0 },   // wasted: high spend, zero sales
    [RETARGET]: { spend: 150, conv: 2 }, // cheap + converts
  };
  const rows: any[] = [];
  for (let d = days; d >= 0; d--) {
    const day = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    for (const ad of [VIDEO, STATIC, RETARGET]) {
      const p = prof[ad];
      const wobble = 0.8 + (0.4 * ((d * 7 + ad.charCodeAt(4)) % 10) / 10);
      const spend = Math.round(p.spend * wobble * 100) / 100;
      rows.push({
        adMetaId: ad, adAccountId: acct.id, clientId, day,
        spend, inrSpend: spend, currency: "INR", inrRate: 1,
        impressions: Math.round(600 * wobble), reach: Math.round(300 * wobble),
        clicks: Math.round(120 * wobble), linkClicks: Math.round(80 * wobble),
        thruPlays: ad === VIDEO ? Math.round(200 * wobble) : 0,
        // Meta over-reports slightly on the video ad (spec 7 "Meta vs Track").
        metaConversions: d % 7 === 0 ? p.conv + 1 : p.conv,
      });
    }
  }
  await prisma.spend.createMany({ data: rows });

  return { adAccount: acct.id, videoAd: VIDEO, staticAd: STATIC, retargetAd: RETARGET };
}

/**
 * Full report fixture (spec §8: fixture-own, not seed): builds the G1-style
 * Upcurvv ad tree AND the lead-side rows (leads, timeline events, payments)
 * that `reports.ts` aggregates. Deterministic ids + timestamps anchored to
 * "now" so the default 30-day windows actually contain data.
 *
 * Shape (mirrors what a real G3+G4 week produces):
 *   - fx_a_video   : converts (credited sales + a meta over-report)
 *   - fx_a_static  : high spend, ZERO sales  -> the "wasted spend" case
 *   - fx_a_ret     : cheap, converts
 * Leads: 3 journeys + 1 instant-form + 1 source-unknown; one refund for the
 * net-of-refunds math; a touchpoint carrying an ad id for source-mix.
 */
export async function reportFixture(
  prisma: PrismaClient,
  clientId: string,
  opts: { spendDays?: number } = {}
): Promise<{ videoAd: string; staticAd: string; retargetAd: string }> {
  const spendDays = opts.spendDays ?? 30;
  const acct = await fixtureAdAccount(prisma, clientId, { days: spendDays });

  const ago = (days: number, hour = 9) => {
    const d = new Date(); d.setDate(d.getDate() - days); d.setHours(hour, 0, 0, 0); return d;
  };
  const iso = (d: Date) => d.toISOString();
  // Event ad-id payloads are read off `rawPayload` (spec 4: keep raw).
  const adEv = (type: string, adId: string, daysAgo: number) =>
    JSON.stringify({ ad_id: adId, adset_id: "fx_aset", campaign_id: "fx_cam", timestamp: iso(ago(daysAgo)) });

  // --- Leads (journeys) ----------------------------------------------------
  const L = {
    paid: "fx_ld_paid", attended: "fx_ld_attended", registered: "fx_ld_reg",
    instant: "fx_ld_instant", unknown: "fx_ld_unknown",
  };
  await prisma.lead.createMany({ data: [
    { id: L.paid, clientId, phone: "+919812340901", phoneNormalized: "+919812340901", email: "paid@x.com", emailNormalized: "paid@x.com", name: "Paid Person", stage: "Paid", createdAt: ago(25) },
    { id: L.attended, clientId, phone: "+919812340902", phoneNormalized: "+919812340902", email: "att@x.com", emailNormalized: "att@x.com", name: "Attended", stage: "Attended", createdAt: ago(20) },
    { id: L.registered, clientId, phone: "+919812340903", phoneNormalized: "+919812340903", email: "reg@x.com", emailNormalized: "reg@x.com", name: "Registered", stage: "Registered", createdAt: ago(10) },
    { id: L.instant, clientId, phone: "+919812340904", phoneNormalized: "+919812340904", email: "inst@x.com", emailNormalized: "inst@x.com", name: "Instant Form", stage: "Paid", createdAt: ago(5) },
    { id: L.unknown, clientId, sourceUnknown: true, phone: null, phoneNormalized: null, email: "walkin@x.com", emailNormalized: "walkin@x.com", name: "Walk-in", stage: "Paid", createdAt: ago(2) },
  ]});

  // --- Timeline events (drive funnel counts + attribution) ----------------
  await prisma.event.createMany({ data: [
    { id: "ev_paid_reg", leadId: L.paid, clientId, type: "registered", sourcePlatform: "aevent", rawPayload: "{}", timestamp: ago(25) },
    { id: "ev_paid_att", leadId: L.paid, clientId, type: "webinar_joined", sourcePlatform: "aevent", rawPayload: "{}", timestamp: ago(24) },
    { id: "ev_paid_call", leadId: L.paid, clientId, type: "call_booked", sourcePlatform: "calendly", rawPayload: "{}", timestamp: ago(23) },
    // ad-carrying click -> credits fx_a_video (last-paid-click).
    { id: "ev_paid_click", leadId: L.paid, clientId, type: "form_submit", sourcePlatform: "aevent", rawPayload: adEv("form_submit", acct.videoAd, 22), timestamp: ago(22) },
    { id: "ev_paid_pay", leadId: L.paid, clientId, type: "payment_success", sourcePlatform: "razorpay", value: 4999, currency: "INR", rawPayload: JSON.stringify({ txn: "rzp_fx_1" }), timestamp: ago(2) },
    // attended journey
    { id: "ev_att_reg", leadId: L.attended, clientId, type: "registered", sourcePlatform: "aevent", rawPayload: "{}", timestamp: ago(20) },
    { id: "ev_att_join", leadId: L.attended, clientId, type: "webinar_joined", sourcePlatform: "aevent", rawPayload: "{}", timestamp: ago(19) },
    // registered journey
    { id: "ev_reg_reg", leadId: L.registered, clientId, type: "registered", sourcePlatform: "aevent", rawPayload: "{}", timestamp: ago(10) },
    // instant-form lead (meta_form_lead carries ad id + a purchase)
    { id: "ev_inst_lead", leadId: L.instant, clientId, type: "meta_form_lead", sourcePlatform: "meta", rawPayload: adEv("meta_form_lead", acct.retargetAd, 5), timestamp: ago(5) },
    { id: "ev_inst_pay", leadId: L.instant, clientId, type: "payment_success", sourcePlatform: "razorpay", value: 24999, currency: "INR", rawPayload: JSON.stringify({ txn: "rzp_fx_4" }), timestamp: ago(3) },
    // source-unknown walk-in purchase
    { id: "ev_un_pay", leadId: L.unknown, clientId, type: "payment_success", sourcePlatform: "unknown", value: 4999, currency: "INR", rawPayload: "{}", timestamp: ago(1) },
  ]});

  // --- Payments (net-of-refunds math: one paid, one refunded) -------------
  await prisma.payment.createMany({ data: [
    { id: "pay_fx_1", leadId: L.paid, clientId, amount: 4999, currency: "INR", gateway: "razorpay", gatewayTxnId: "rzp_fx_1", status: "paid", paidAt: ago(2) },
    { id: "pay_fx_4", leadId: L.instant, clientId, amount: 24999, currency: "INR", gateway: "razorpay", gatewayTxnId: "rzp_fx_4", status: "paid", paidAt: ago(3) },
    { id: "pay_fx_u", leadId: L.unknown, clientId, amount: 4999, currency: "INR", gateway: "unknown", gatewayTxnId: "walkin_fx", status: "paid", paidAt: ago(1) },
    { id: "pay_fx_ref", leadId: L.attended, clientId, amount: 999, currency: "INR", gateway: "cashfree", gatewayTxnId: "cf_fx_ref", status: "refunded", paidAt: ago(15), refundedAt: ago(14), refundEventId: "ev_ref" },
  ]});

  // --- A touchpoint carrying an ad id (source-mix "landing page" bucket) ---
  await prisma.visitor.create({ data: { visitorId: "fx_v_1", clientId } });
  await prisma.touchpoint.create({ data: {
    id: "fx_tp_1", visitorId: "fx_v_1", clientId, kind: "ad_click",
    adId: acct.videoAd, adsetId: "fx_aset", campaignId: "fx_cam",
    utmSource: "facebook", timestamp: ago(22),
  }});

  return { videoAd: acct.videoAd, staticAd: acct.staticAd, retargetAd: acct.retargetAd };
}
