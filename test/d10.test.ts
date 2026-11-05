/**
 * D-10 — client exception fix + ad-set metrics + live range fetch.
 *
 *   - Client scoping A-vs-B: selecting client A shows ZERO client-B ad sets
 *     (ad sets, active-entity counts, and the ad-set table all scoped by
 *     the entities' own clientId — the pre-D-10 active-entity block compared
 *     `adAccountId IN clientIds`, a cuid vs cl_… mismatch that always 0'd,
 *     and the creatives count scanned ALL clients' ads (a cross-client leak)).
 *   - Ad-set metrics: per-ad-set name/campaign, spend (native + INR),
 *     impressions, reach, clicks, CPM, CPC, ROAS — from STORED Spend rows
 *     only; LPV/CLPV are NOT fields (probe 400) and no cost/LPV is guessed.
 *   - Live range fetch: cache-first (same day+range = reuse, no repeated Meta
 *     hit), BLOCKED path stores the EXACT Meta 4xx string (never a fake
 *     number / empty grid), no-token = honest skip.
 *   - Suspense regression: RangePicker + Topbar render their
 *     useSearchParams-reading core inside a <Suspense> boundary (the
 *     client-nav invariant; the sentinel repro in .d10-repro.txt proves the
 *     runtime behaviour on the prod build — clean transition, 0 console
 *     errors).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { freshDb, reportFixture, TestDb } from "./helpers";
import { dashboardAll } from "../src/lib/dashboard";
import { adSetPerformance, LPV_CLPV_NOTE, AdSetRow as AdSetRowType } from "../src/lib/reports";
import { resolveLiveRange } from "../src/lib/meta/live-range";

/** Build a second, distinct client B ad tree (own account/adset/ad metaIds —
 *  the G1 fixture's ids are globally-unique @id keys, so B needs its own).
 *  Creates the Client row first (AdAccount.clientId is an FK). */
async function buildClientBTree(prisma: PrismaClient, clientId: string) {
  const ws = await prisma.workspace.findFirst();
  if (!ws) throw new Error("no workspace in bootstrap");
  const clientRow = await prisma.client.findUnique({ where: { id: clientId } });
  if (!clientRow) {
    await prisma.client.create({ data: { id: clientId, workspaceId: ws.id, name: "Client B", currency: "INR" } });
  }
  await prisma.adAccount.create({ data: { metaId: "act_9999_b", clientId, name: "Client B acct", currency: "INR" } });
  const acct = await prisma.adAccount.findUniqueOrThrow({ where: { metaId: "act_9999_b" } });
  await prisma.adCampaign.create({ data: { metaId: "cam_b_1", adAccountId: acct.id, clientId, name: "Campaign B", status: "ACTIVE" } });
  await prisma.adSet.create({ data: { metaId: "set_b_1", adAccountId: acct.id, campaignMetaId: "cam_b_1", clientId, name: "Ad Set B", status: "ACTIVE" } });
  await prisma.ad.create({ data: { metaId: "ad_b_1", adAccountId: acct.id, adSetMetaId: "set_b_1", clientId, name: "Ad B", status: "ACTIVE" } });
  const day = new Date().toISOString().slice(0, 10);
  await prisma.spend.create({
    data: {
      adMetaId: "ad_b_1", adAccountId: acct.id, clientId, day,
      spend: 5000, inrSpend: 5000, inrRate: 1, currency: "INR",
      impressions: 10000, reach: 5000, clicks: 200, linkClicks: 150, thruPlays: 0, metaConversions: 0,
    },
  });
  return { adSetMetaId: "set_b_1", acctId: acct.id };
}

describe("D-10 client scoping — client A selected shows ZERO client B ad sets", () => {
  it("ad-set table + active-entity counts are scoped to the selected client only", async () => {
    const db = await freshDb();
    const prisma = db.prisma;
    const clA = "cl_upcurvv"; // bootstrap client
    await reportFixture(prisma, clA, { spendDays: 30 }); // A's G1-style tree + spend
    const b = await buildClientBTree(prisma, "cl_b"); // B: own account + ACTIVE ad + spend
    const bMetaIds = [b.adSetMetaId];

    try {
      // Select client A only (the ?client= path drives dashboardAll's clientIds).
      const d = await dashboardAll(prisma, [clA]);
      // (1) The ad-set table: no B ad-set id anywhere.
      for (const row of d.adSets as AdSetRowType[]) expect(bMetaIds).not.toContain(row.adsetId);
      // (2) The active-entity KPI counts: B's ACTIVE ad must not leak in.
      const aActiveAds = await prisma.ad.count({ where: { clientId: clA, status: "ACTIVE" } });
      expect(d.kpi.engagement.activeAds).toBe(aActiveAds);
      expect(d.kpi.engagement.activeAds).not.toBeGreaterThan(aActiveAds);
      // (3) Accounts strip: no B account row.
      expect(d.accounts.map((a) => a.metaId)).not.toContain("act_9999_b");
      expect(d.accounts.map((a) => a.name)).not.toContain("Client B acct");

      // Reverse: selecting B shows B's ad set and NONE of A's.
      const dB = await dashboardAll(prisma, ["cl_b"]);
      expect(dB.adSets.map((r) => r.adsetId)).toContain(b.adSetMetaId);
      const aSetMetas = new Set((await adSetPerformance(prisma, clA)).map((r) => r.adsetId));
      for (const row of dB.adSets) expect([...aSetMetas]).not.toContain(row.adsetId);
    } finally {
      await db.close();
    }
  });
});

describe("D-10 ad-set metrics — stored Spend/AdSet rows only, LPV/CLPV never faked", () => {
  it("computes CPM/CPC/ROAS + native/INR spend from stored rows; exposes no LPV/CLPV fields", async () => {
    const db = await freshDb();
    const prisma = db.prisma;
    await reportFixture(prisma, "cl_upcurvv", { spendDays: 30 });
    try {
      const rows = await adSetPerformance(prisma, "cl_upcurvv");
      expect(rows.length).toBeGreaterThan(0);
      const r = rows[0];
      // Every metric is derived from the stored Spend rows (no live call, no guess).
      expect(Number.isFinite(r.spendNative)).toBe(true);
      expect(Number.isFinite(r.spendInr)).toBe(true);
      // CPM = spendInr/impressions*1000; CPC = spendInr/clicks (0 when no clicks).
      if (r.impressions > 0) {
        expect(r.cpm).toBeCloseTo((r.spendInr / r.impressions) * 1000, 0);
      }
      if (r.clicks > 0) expect(r.cpc).toBeCloseTo(r.spendInr / r.clicks, 0);
      else expect(r.cpc).toBe(0);
      // ROAS is a value only where sales exist — pre G3/G4 there are none,
      // so the honest 0 (never a fabricated ratio).
      expect(r.roas).toBe(0);
      // LPV/CLPV: the probe 400'd them on this API → the row exposes NO
      // lpv/clpv/cost-per-lpv field at all (a zero-column or a guessed
      // cost/LPV would be a fake number; the UI shows the LPV_CLPV_NOTE).
      const keys = Object.keys(r);
      for (const bad of ["lpv", "clpv", "costLpv", "costPerLpv", "lpvCost"]) expect(keys, `unexpected LPV/CLPV field '${bad}'`).not.toContain(bad);
      // The honest note is present + says exactly what it means.
      expect(LPV_CLPV_NOTE).toMatch(/LPV\/CLPV not returned by Meta v23\.0/i);
      expect(LPV_CLPV_NOTE).toMatch(/400/);
    } finally {
      await db.close();
    }
  });
});

describe("D-10 live range fetch — cache-first, BLOCKED keeps the exact Meta string", () => {
  async function seedAccount() {
    const db = await freshDb();
    const acct = await db.prisma.adAccount.findFirst();
    if (!acct) throw new Error("bootstrap ad-account link row missing");
    return { db, prisma: db.prisma, acctId: acct.id };
  }

  it("first call fetches Meta once; same day+range REUSES the cache (no repeated Meta hit)", async () => {
    const { db, prisma, acctId } = await seedAccount();
    let metaHits = 0;
    const fakeFetch: typeof fetch = async () => {
      metaHits++;
      return new Response(JSON.stringify({ data: [{ date_start: "2026-11-04", date_stop: "2026-11-04", spend: "6624" }] }), { status: 200 });
    };
    const deps = { token: "tok-test", fetch: fakeFetch };
    try {
      const first = await resolveLiveRange(prisma, acctId, "yesterday", deps);
      expect(first.ok).toBe(true);
      expect(first.cached).toBe(false);
      expect(first.spendNative).toBe(6624);
      expect(metaHits).toBe(1);

      const second = await resolveLiveRange(prisma, acctId, "yesterday", deps);
      expect(second.cached).toBe(true); // same day + range = reuse
      expect(second.spendInr).toBe(first.spendInr);
      expect(metaHits).toBe(1); // NO second Meta call — the idempotency rule
    } finally {
      await db.close();
    }
  });

  it("a Meta 4xx is stored as a BLOCKED row with the EXACT error string (never a fake value / empty grid)", async () => {
    const { db, prisma, acctId } = await seedAccount();
    let metaHits = 0;
    const fakeFetch: typeof fetch = async () => {
      metaHits++;
      return new Response(
        JSON.stringify({ error: { message: "The parameter end_time is invalid.", code: 100, error_subcode: 2020832 } }),
        { status: 400 },
      );
    };
    const deps = { token: "tok-test", fetch: fakeFetch };
    try {
      const first = await resolveLiveRange(prisma, acctId, "7d", deps);
      expect(first.ok).toBe(false);
      expect(first.blockedNote).toMatch(/The parameter end_time is invalid/); // the EXACT Meta string
      expect(first.blockedNote).toMatch(/400/);
      expect(first.spendInr).toBe(0); // zeros, not a fabricated number
      expect(metaHits).toBe(1);

      // Re-hit reuses the BLOCKED row (still exact-string, still no fake).
      const second = await resolveLiveRange(prisma, acctId, "7d", deps);
      expect(second.cached).toBe(true);
      expect(second.blockedNote).toBe(first.blockedNote);
      expect(metaHits).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("no token = honest skip (BLOCKED note, never a fabricated value)", async () => {
    const { db, prisma, acctId } = await seedAccount();
    const r = await resolveLiveRange(prisma, acctId, "yesterday", { token: "", fetch: (async () => new Response("{}")) as typeof fetch });
    expect(r.ok).toBe(false);
    expect(r.blockedNote).toMatch(/no META_ACCESS_TOKEN/);
    expect(r.spendInr).toBe(0);
    await db.close();
  });
});

describe("D-10 Suspense boundary regression — useSearchParams consumers are Suspense-wrapped", () => {
  // Source-level invariant (the runtime proof is the sentinel repro,
  // .d10-repro.txt: unfixed components force a full reload on range-select;
  // the Suspense-bounded build is a clean client-side transition, 0 errors).
  // This test guards against the boundary being dropped in a later refactor.
  it.each([
    ["src/app/components/RangePicker.tsx"],
    ["src/app/components/Topbar.tsx"],
  ])("%s wraps its useSearchParams core in a <Suspense> boundary", (rel) => {
    const src = readFileSync(rel, "utf8");
    expect(src).toMatch(/<Suspense\b/);
    // The component that calls useSearchParams must not be the exported one:
    // the export is the Suspense wrapper (…Inner is inside). (The literal
    // "useSearchParams()" also appears in doc comments, so assert ≥1 call
    // rather than an exact count — the wrapper check below is the invariant.)
    expect((src.match(/useSearchParams\(\)/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(src).toMatch(/export function (RangePicker|Topbar)\b[\s\S]{0,400}<Suspense/);
  });
});
