/**
 * D-12 — dashboard engagement KPIs + per-client event_source_url for CAPI live.
 *
 * Task 1 (engagement KPIs, stored rows only):
 *   - Total Impressions / Reach / Clicks + CTR + CPC computed ONLY over the
 *     same stored Spend rows the spend KPIs use — verified for the
 *     All-clients set, a single client, and a per-ad-account drill-down
 *     (the A-only view must show ZERO of B's rows, and vice versa).
 *   - CTR/CPC math exact (clicks/impressions; spendInr/clicks).
 *   - LPV/CLPV: NOT fields anywhere on the KPI (probe 400, D-08) and the
 *     dashboard page renders the honest footnote, never a zero column.
 *
 * Task 2 (event_source_url, D-11's blocker):
 *   - the .env value-free tier: eventSourceUrlForClient reads
 *     META_EVENT_SOURCE_URL_<CLIENT> (PO-supplied URL; a placeholder /
 *     non-URL value is rejected, never returned).
 *   - the .env URL flows into the LIVE POST (action_source "website" +
 *     event_source_url = the .env value, never a literal / placeholder).
 *   - D-12 promotion: a row a D-11 run left SIMULATED (no source URL yet)
 *     is re-queued and LIVE-sent on the first run where a URL exists.
 *   - a no-pixel client stays simulated with the exact note (never 400).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { freshDb, TestDb } from "./helpers";
import { dashboardAll } from "../src/lib/dashboard";
import { sendQueue } from "../src/lib/meta/capi";
import { capiDedupKey } from "../src/lib/capi";
import { hashPhoneForCapi, hashEmailForCapi } from "../src/lib/hash";
import { eventSourceUrlForClient } from "../src/lib/meta/pixel-map";

/** Deterministic engagement fixture: one client, one ad account, N spend rows
 *  with known totals (so CTR/CPC math is exact). Same window as the KPIs. */
async function makeClientTree(
  prisma: PrismaClient,
  clientId: string,
  acctMetaId: string,
  rows: { dayOffset: number; spend: number; impressions: number; reach: number; clicks: number; thruPlays: number }[],
) {
  const ws = await prisma.workspace.findFirst();
  if (!ws) throw new Error("no workspace in bootstrap");
  const existing = await prisma.client.findUnique({ where: { id: clientId } });
  if (!existing) await prisma.client.create({ data: { id: clientId, workspaceId: ws.id, name: `C ${clientId}`, currency: "INR" } });
  await prisma.adAccount.upsert({
    where: { metaId: acctMetaId },
    update: { clientId },
    create: { metaId: acctMetaId, clientId, name: `Acct ${acctMetaId}`, currency: "INR" },
  });
  const acct = await prisma.adAccount.findUniqueOrThrow({ where: { metaId: acctMetaId } });
  await prisma.adCampaign.upsert({
    where: { metaId: `cam_${clientId}` },
    update: {},
    create: { metaId: `cam_${clientId}`, adAccountId: acct.id, clientId, name: "cam", status: "ACTIVE" },
  });
  await prisma.adSet.upsert({
    where: { metaId: `set_${clientId}` },
    update: {},
    create: { metaId: `set_${clientId}`, adAccountId: acct.id, campaignMetaId: `cam_${clientId}`, clientId, name: "set", status: "ACTIVE" },
  });
  await prisma.ad.upsert({
    where: { metaId: `ad_${clientId}` },
    update: {},
    create: { metaId: `ad_${clientId}`, adAccountId: acct.id, adSetMetaId: `set_${clientId}`, clientId, name: "ad", status: "ACTIVE" },
  });
  const dayOf = (off: number) => new Date(Date.now() - off * 86_400_000).toISOString().slice(0, 10);
  await prisma.spend.createMany({
    data: rows.map((r) => ({
      adMetaId: `ad_${clientId}`,
      adAccountId: acct.id,
      clientId,
      day: dayOf(r.dayOffset),
      spend: r.spend,
      inrSpend: r.spend, // INR account, 1:1
      inrRate: 1,
      currency: "INR",
      impressions: r.impressions,
      reach: r.reach,
      clicks: r.clicks,
      linkClicks: r.clicks,
      thruPlays: r.thruPlays,
      metaConversions: 0,
    })),
  });
  return { acctMetaId };
}

const A = "cl_upcurvv"; // bootstrap client
const B = "cl_b"; // a distinct second client (built here)
const ACCT_A = "act_4749960348632164"; // the G1 link-row metaId
const ACCT_B = "act_b_1";

/** A's known totals: imp 3000 · reach 1200 · clicks 90 · spend 300 · thru 37.
 *  B's: imp 5000 · reach 2500 · clicks 100 · spend 400 · thru 10. */
const ROWS_A = [
  { dayOffset: 0, spend: 100, impressions: 1000, reach: 400, clicks: 30, thruPlays: 37 },
  { dayOffset: 1, spend: 200, impressions: 2000, reach: 800, clicks: 60, thruPlays: 0 },
];
const ROWS_B = [{ dayOffset: 0, spend: 400, impressions: 5000, reach: 2500, clicks: 100, thruPlays: 10 }];

describe("D-12 engagement KPIs — stored Spend rows only, exact CTR/CPC math", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
    await makeClientTree(db.prisma, A, ACCT_A, ROWS_A);
    await makeClientTree(db.prisma, B, ACCT_B, ROWS_B);
  });
  afterEach(async () => {
    await db.close();
  });

  it("All-clients set: totals = every stored row of the set (no B leak into A, no A into B)", async () => {
    const all = await dashboardAll(db.prisma, [A, B]);
    const e = all.kpi.engagement;
    expect(e.impressions).toBe(3000 + 5000);
    expect(e.reach).toBe(1200 + 2500);
    expect(e.clicks).toBe(90 + 100);
    expect(e.thruPlays).toBe(37 + 10);
    // CTR + CPC from the SAME stored rows (spendInr total = 700 here).
    expect(all.kpi.spendInr).toBe(700);
    expect(e.ctr).toBeCloseTo(190 / 8000, 6);
    expect(e.cpc).toBeCloseTo(700 / 190, 4);
  });

  it("single-client scope: client A's KPIs show ZERO of B's rows (and the reverse)", async () => {
    const a = await dashboardAll(db.prisma, [A]);
    expect(a.kpi.engagement.impressions).toBe(3000); // B's 5000 absent
    expect(a.kpi.engagement.clicks).toBe(90);
    expect(a.kpi.engagement.ctr).toBeCloseTo(90 / 3000, 6);
    expect(a.kpi.engagement.cpc).toBeCloseTo(300 / 90, 4);

    const b = await dashboardAll(db.prisma, [B]);
    expect(b.kpi.engagement.impressions).toBe(5000); // A's 3000 absent
    expect(b.kpi.engagement.clicks).toBe(100);
    expect(b.kpi.engagement.ctr).toBeCloseTo(100 / 5000, 6);
    expect(b.kpi.engagement.cpc).toBeCloseTo(400 / 100, 4);
  });

  it("per-ad-account drill-down scopes the KPIs to that account's rows", async () => {
    const d = await dashboardAll(db.prisma, [A, B], "last_paid_click", 30, ACCT_B);
    const e = d.kpi.engagement;
    expect(e.impressions).toBe(5000); // only B's account rows
    expect(e.clicks).toBe(100);
    expect(e.cpc).toBeCloseTo(400 / 100, 4);
    expect(d.accounts.map((a) => a.metaId)).toEqual([ACCT_B]);
  });

  it("LPV/CLPV: no lpv/clpv/cost-per-lpv field anywhere on the KPIs; the page renders the honest footnote", async () => {
    const d = await dashboardAll(db.prisma, [A, B]);
    for (const bad of ["lpv", "clpv", "costLpv", "costPerLpv", "lpvCost"]) {
      expect(bad, `unexpected KPI field '${bad}'`).not.toBe(Object.keys(d.kpi).join(","));
      expect(bad, `unexpected engagement field '${bad}'`).not.toBe(Object.keys(d.kpi.engagement).join(","));
    }
    // The dashboard page renders the footnote (never a zero column):
    const page = readFileSync("src/app/page.tsx", "utf8");
    expect(page).toMatch(/LPV\/CLPV not available on this Meta API version/i);
    expect(page).toMatch(/400/);
    // …and the engagement KPI row itself:
    for (const label of ["Total Impressions", "Total Reach", "Total Clicks", "CTR", "CPC"]) expect(page).toContain(label);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — the .env event_source_url tier + D-11 simulated-row promotion.
// (Vitest does NOT load .env into process.env — the .env-tier tests set the
// var explicitly in-process; production reads the real .env values.)
// ---------------------------------------------------------------------------

const U = "cl_upcurvv";
const NONE = "cl_piyush-ahuja"; // no pixel key, no URL key (D-07/D-12 "lacks" case)

interface MetaCall { url: string; init: { body: string; method: string } }
function mockMeta(calls: MetaCall[], responder: (n: number) => { ok: boolean; status: number; body: unknown }) {
  return async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const r = responder(calls.length - 1);
    const json = JSON.stringify(r.body);
    return { ok: r.ok, status: r.status, json: async () => JSON.parse(json), text: async () => json } as unknown as Response;
  };
}

async function seedPurchaseRow(prisma: PrismaClient, clientId: string) {
  const lead = await prisma.lead.create({
    data: { clientId, phone: "+919812340011", phoneNormalized: "+919812340011", email: "d12@x.com", emailNormalized: "d12@x.com" },
  });
  const dedupKey = capiDedupKey("Purchase", { clientId, leadId: lead.id, phone: lead.phone, email: lead.email }, "d12_txn");
  const row = await prisma.outboundEvent.create({
    data: {
      clientId,
      leadId: lead.id,
      type: "Purchase",
      value: 4999,
      currency: "INR",
      clientIp: "10.0.0.9",
      userAgent: "d12-test/1.0",
      hashedPhone: hashPhoneForCapi("+919812340011"),
      hashedEmail: hashEmailForCapi("d12@x.com"),
      eventTime: new Date("2026-11-05T10:00:00Z"),
      eventId: dedupKey,
      dedupKey,
      status: "queued",
      matchQuality: 7,
    },
  });
  return { lead, row };
}

describe("D-12 event_source_url — .env value-free tier + simulated-row promotion", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
    // Deterministic start: no URL in any tier (vitest never loads .env, and
    // the bootstrap has no Funnel rows).
    for (const k of Object.keys(process.env)) if (k.startsWith("META_EVENT_SOURCE_URL_")) delete process.env[k];
  });
  afterEach(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("META_EVENT_SOURCE_URL_")) delete process.env[k];
    await db.close();
  });

  it("eventSourceUrlForClient: the .env value flows through verbatim; a placeholder / non-URL is rejected (null)", async () => {
    // A client with no key at all -> null (never a literal, never a 400's cause).
    expect(eventSourceUrlForClient(NONE)).toBeNull();
    process.env.META_EVENT_SOURCE_URL_CL_UPCURVV = "https://join.upcurvv.com/cll";
    expect(eventSourceUrlForClient(U)).toBe("https://join.upcurvv.com/cll"); // verbatim .env value
    // Garbage values are NOT returned (a placeholder must never reach Meta):
    process.env.META_EVENT_SOURCE_URL_CL_UPCURVV = "pixel";
    expect(eventSourceUrlForClient(U)).toBeNull();
    process.env.META_EVENT_SOURCE_URL_CL_UPCURVV = "not-a-url";
    expect(eventSourceUrlForClient(U)).toBeNull();
  });

  it("the .env URL flows into the LIVE POST (website source + event_source_url = the .env value)", async () => {
    const { row } = await seedPurchaseRow(db.prisma, U);
    process.env.META_EVENT_SOURCE_URL_CL_UPCURVV = "https://join.upcurvv.com/cll";
    const calls: MetaCall[] = [];
    const out = await sendQueue(db.prisma, U, {
      metaAccessToken: "tok",
      metaPixelId: "4438125733120237", // the .env pixel shape (numeric)
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: { fbtrace_id: "fbt_d12" } })) as unknown as typeof fetch,
    });
    expect(out.live).toBe(1);
    expect(out.simulated).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/4438125733120237/events"); // the real pixel, never 'pixel'
    const ev = (JSON.parse(String(calls[0].init.body)).data[0]) as Record<string, unknown>;
    expect(ev.action_source).toBe("website");
    expect(ev.event_source_url).toBe("https://join.upcurvv.com/cll"); // the .env value, verbatim
    const got = await db.prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(got.status).toBe("sent");
    expect(got.sentToMeta).toBe(true);
    expect(got.simulated).toBe(false);
    expect(got.pixelUsed).toBe("4438125733120237");
  });

  it("D-12 promotion: a D-11-simulated row (no URL back then) goes LIVE on the first run where the URL exists", async () => {
    const { row } = await seedPurchaseRow(db.prisma, U);
    // Run 1 — no URL anywhere: stays simulated with the exact D-11/D-12 note.
    const out1 = await sendQueue(db.prisma, U, {
      metaAccessToken: "tok",
      metaPixelId: "4438125733120237",
      fetch: mockMeta([], () => ({ ok: true, status: 200, body: {} })) as unknown as typeof fetch,
    });
    expect(out1.simulated).toBe(1);
    expect(out1.live).toBe(0);
    const after1 = await db.prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after1.status).toBe("sent");
    expect(after1.simulated).toBe(true);
    expect(after1.sentToMeta).toBe(false);
    expect(after1.error).toMatch(/no event source URL for this client/i);
    // Run 2 — the .env URL now exists: the simulated row is re-queued and
    // LIVE-sent (its FIRST Meta send — the frozen event_id dedups any repeat).
    process.env.META_EVENT_SOURCE_URL_CL_UPCURVV = "https://join.upcurvv.com/cll";
    const calls: MetaCall[] = [];
    const out2 = await sendQueue(db.prisma, U, {
      metaAccessToken: "tok",
      metaPixelId: "4438125733120237",
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: { fbtrace_id: "fbt_promo" } })) as unknown as typeof fetch,
    });
    expect(out2.live).toBe(1);
    expect(calls).toHaveLength(1);
    const after2 = await db.prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after2.status).toBe("sent");
    expect(after2.sentToMeta).toBe(true);
    expect(after2.simulated).toBe(false);
    expect(after2.pixelUsed).toBe("4438125733120237");
  });

  it("a no-pixel, no-URL client stays SIMULATED with the exact note (never a 400, never a fake)", async () => {
    const ws = await db.prisma.workspace.findFirst();
    if (!ws) throw new Error("no workspace");
    await db.prisma.client.create({ data: { id: NONE, workspaceId: ws.id, name: "Piyush Ahuja", currency: "INR" } });
    const { row } = await seedPurchaseRow(db.prisma, NONE);
    const calls: MetaCall[] = [];
    const out = await sendQueue(db.prisma, NONE, {
      metaAccessToken: "tok",
      metaPixelId: null, // no pixel key for this client (D-07)
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: {} })) as unknown as typeof fetch,
    });
    expect(out.simulated).toBe(1);
    expect(out.live).toBe(0);
    expect(calls).toHaveLength(0); // no network at all
    const got = await db.prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(got.simulated).toBe(true);
    expect(got.sentToMeta).toBe(false);
    expect(got.error).toMatch(/no pixel configured for this client/i);
    expect(got.pixelUsed).toBeNull();
  });
});
