import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers";
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

const FIT = "cl_fitness";

describe("reports (spec 7) — off the seeded demo data", () => {
  it("funnelReport has spend, counts, and cost-per values", async () => {
    const { prisma, close } = await freshDb();
    const r = await funnelReport(prisma, FIT);
    expect(r.spendInr).toBeGreaterThan(0); // 30-day daily USD series * FX
    expect(r.leads).toBeGreaterThan(0);
    expect(r.registered).toBeGreaterThan(0);
    expect(r.attended).toBeGreaterThan(0);
    expect(r.revenueInr).toBeGreaterThan(0);
    expect(r.costPerSale).toBeGreaterThan(0);
    // 30 days of ad spend out-earns the small demo revenue by construction, so
    // ROI is negative but must still be a finite, computed number.
    expect(Number.isFinite(r.roi)).toBe(true);
    expect(r.showUpRate).toBeGreaterThan(0);
    expect(r.closeRate).toBeGreaterThan(0);
    await close();
  });

  it("adPerformance returns ad rows with spend, ROAS, and thumbnails", async () => {
    const { prisma, close } = await freshDb();
    const rows = await adPerformance(prisma, FIT);
    expect(rows.length).toBeGreaterThanOrEqual(3); // ad_101..103
    const byId = Object.fromEntries(rows.map((r) => [r.adId, r]));
    expect(byId.ad_101!.thumbnail).toMatch(/picsum/);
    expect(byId.ad_101!.roas).toBeGreaterThan(0); // converting video ad
    await close();
  });

  it("wastedSpend flags the high-spend zero-sales ad (ad_102)", async () => {
    const { prisma, close } = await freshDb();
    const rows = await wastedSpend(prisma, FIT, 2000);
    const ids = rows.map((r) => r.adId);
    expect(ids).toContain("ad_102");
    expect(rows.every((r) => r.sales === 0)).toBe(true);
    await close();
  });

  it("newVsOld splits sales by lead-creation date", async () => {
    const { prisma, close } = await freshDb();
    const r = await newVsOld(prisma, FIT);
    expect(r.newSales + r.oldSales).toBeGreaterThan(0);
    expect(r.newSales).toBeGreaterThan(0); // ld_009 created 5d ago, paid 3d ago
    await close();
  });

  it("metaVsTrack compares Meta-reported vs counted conversions per ad", async () => {
    const { prisma, close } = await freshDb();
    const rows = await metaVsTrack(prisma, FIT);
    expect(rows.length).toBeGreaterThan(0);
    // Meta intentionally over-reports slightly in the seed (spec 7).
    const anyOver = rows.some((r) => r.over);
    expect(anyOver).toBe(true);
    await close();
  });

  it("sourceMix buckets leads into instant form / landing / organic / unknown", async () => {
    const { prisma, close } = await freshDb();
    const m = await sourceMix(prisma, FIT);
    expect(m.total).toBeGreaterThan(0);
    expect(m.instantForm).toBeGreaterThan(0); // ld_008 via a Meta form
    expect(m.unknown).toBeGreaterThan(0); // ld_003 sourceUnknown
    await close();
  });

  it("weeklySummary composes all reports + is CSV-exportable (spec 7)", async () => {
    const { prisma, close } = await freshDb();
    const w = await weeklySummary(prisma, FIT);
    expect(w.funnel.spendInr).toBeGreaterThan(0);
    expect(w.topAds.length).toBeGreaterThan(0);
    const csv = toCsv(w.metaVsTrack);
    expect(csv.split("\n")[0]).toMatch(/adId,adName,metaConversions,ourConversions/);
    await close();
  });
});
