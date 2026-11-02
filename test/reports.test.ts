import { describe, it, expect } from "vitest";
import { freshDb, reportFixture, fixtureAdAccount } from "./helpers";
import {
  funnelReport,
  adPerformance,
  wastedSpend,
  newVsOld,
  metaVsTrack,
  sourceMix,
  weeklySummary,
  toCsv,
} from "../src/lib/reports";

// D-01/D-02: reports are no longer read off the seeded demo data. Each test
// builds its OWN fixture (spec §8) — the G1-shaped Upcurvv ad tree + a small
// deterministic lead/journey set — so every assertion is fixture-owned.
const FIT = "cl_upcurvv";

describe("reports (spec 7) — off fixture-owned data", () => {
  it("funnelReport has spend, counts, and cost-per values", async () => {
    const { prisma, close } = await freshDb();
    await reportFixture(prisma, FIT);
    const r = await funnelReport(prisma, FIT);
    expect(r.spendInr).toBeGreaterThan(0); // daily INR series (rate 1:1)
    expect(r.leads).toBeGreaterThan(0);
    expect(r.registered).toBeGreaterThan(0);
    expect(r.attended).toBeGreaterThan(0);
    expect(r.revenueInr).toBeGreaterThan(0);
    expect(r.costPerSale).toBeGreaterThan(0);
    expect(Number.isFinite(r.roi)).toBe(true);
    expect(r.showUpRate).toBeGreaterThan(0);
    expect(r.closeRate).toBeGreaterThan(0);
    await close();
  });

  it("adPerformance returns ad rows with spend, ROAS, and thumbnails", async () => {
    const { prisma, close } = await freshDb();
    const fx = await reportFixture(prisma, FIT);
    const rows = await adPerformance(prisma, FIT);
    expect(rows.length).toBeGreaterThanOrEqual(3); // video / static / retarget
    const byId = Object.fromEntries(rows.map((r) => [r.adId, r]));
    expect(byId[fx.videoAd]!.thumbnail).toMatch(/picsum/);
    expect(byId[fx.videoAd]!.roas).toBeGreaterThan(0); // converting video ad
    await close();
  });

  it("wastedSpend flags the high-spend zero-sales ad", async () => {
    const { prisma, close } = await freshDb();
    const fx = await reportFixture(prisma, FIT);
    // adPerformance reports each ad's max DAILY spend (INR, 1:1 fixture), not a
    // 30-day sum: the static ad's max day is ~₹580, so the threshold sits
    // between it and the cheap retarget ad (~₹174). Only the static ad has
    // zero sales, so it is the sole row returned.
    const rows = await wastedSpend(prisma, FIT, 400);
    const ids = rows.map((r) => r.adId);
    expect(ids).toContain(fx.staticAd); // static ad: high spend, no sales
    expect(rows.every((r) => r.sales === 0)).toBe(true);
    await close();
  });

  it("newVsOld splits sales by lead-creation date", async () => {
    const { prisma, close } = await freshDb();
    await reportFixture(prisma, FIT);
    const r = await newVsOld(prisma, FIT);
    expect(r.newSales + r.oldSales).toBeGreaterThan(0);
    expect(r.newSales).toBeGreaterThan(0); // fx_ld_instant created 5d ago, paid 3d ago
    await close();
  });

  it("metaVsTrack compares Meta-reported vs counted conversions per ad", async () => {
    const { prisma, close } = await freshDb();
    const fx = await reportFixture(prisma, FIT);
    const rows = await metaVsTrack(prisma, FIT);
    expect(rows.length).toBeGreaterThan(0);
    // Fixture over-reports Meta on the video ad (spec 7).
    const video = rows.find((r) => r.adId === fx.videoAd);
    expect(video?.metaConversions).toBeGreaterThan(0);
    expect(rows.some((r) => r.over)).toBe(true);
    await close();
  });

  it("sourceMix buckets leads into instant form / landing / organic / unknown", async () => {
    const { prisma, close } = await freshDb();
    await reportFixture(prisma, FIT);
    const m = await sourceMix(prisma, FIT);
    expect(m.total).toBeGreaterThan(0);
    expect(m.instantForm).toBeGreaterThan(0); // fx_ld_instant via meta_form_lead
    expect(m.unknown).toBeGreaterThan(0); // fx_ld_unknown sourceUnknown
    await close();
  });

  it("weeklySummary composes all reports + is CSV-exportable (spec 7)", async () => {
    const { prisma, close } = await freshDb();
    await reportFixture(prisma, FIT);
    const w = await weeklySummary(prisma, FIT);
    expect(w.funnel.spendInr).toBeGreaterThan(0);
    expect(w.topAds.length).toBeGreaterThan(0);
    const csv = toCsv(w.metaVsTrack);
    expect(csv.split("\n")[0]).toMatch(/adId,adName,metaConversions,ourConversions/);
    await close();
  });

  it("an account with ad tree but NO lead-side rows: empty, honest states", async () => {
    // The post-purge dev.db shape: G1 spend rows exist, leads don't yet.
    const { prisma, close } = await freshDb();
    await fixtureAdAccount(prisma, FIT, { days: 7 });
    const r = await funnelReport(prisma, FIT);
    expect(r.spendInr).toBeGreaterThan(0);
    expect(r.leads).toBe(0); // valid state pre live-traffic (G3/G4)
    expect(r.revenueInr).toBe(0);
    expect(r.roi).toBeLessThan(0); // spend > 0 revenue -> negative ROI, finite
    expect(Number.isFinite(r.roi)).toBe(true);
    const mix = await sourceMix(prisma, FIT);
    expect(mix.total).toBe(0);
    await close();
  });
});
