import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { freshDb } from "./helpers";
import { ensureRate, resolveDayRates, fetchLiveFxRate, backfillMissingInr, backfillInrZeroRows, FX_API } from "../src/lib/fx-store";
import type { TestDb } from "./helpers";

/**
 * Spec 5.7: "store spend in billing currency and in INR, using a stored daily
 * FX rate." fx-store owns the FxRate table: stored rates are read, missing
 * days are filled live (open.er-api) ONCE and persisted, so reports never
 * re-convert at report time (no live-rate drift).
 */
let db: TestDb;
const prisma = () => db.prisma;

beforeEach(async () => {
  db = await freshDb({ seed: false });
});
afterAll(async () => {
  await db?.close();
});

describe("ensureRate — stored-first (spec 5.7)", () => {
  it("returns 1 for INR (identity, no fetch)", async () => {
    const r = await ensureRate(prisma(), "INR", "2026-10-28");
    expect(r).toEqual({ rate: 1, live: false, fetched: false });
  });

  it("returns the stored rate without fetching when a row exists", async () => {
    await prisma().fxRate.create({ data: { date: "2026-10-28", currency: "USD", rateToInr: 85 } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const r = await ensureRate(prisma(), "USD", "2026-10-28");
    expect(r.rate).toBe(85);
    expect(r.fetched).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled(); // stored hit = no network
    fetchSpy.mockRestore();
  });

  it("fills live on a miss, persists it, then reads from the store", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: { INR: 84.55 } }), { status: 200 })
    );
    const first = await ensureRate(prisma(), "USD", "2026-10-29");
    expect(first).toEqual({ rate: 84.55, live: true, fetched: true });

    // The live fetch used the pulled currency as the base: /v6/latest/USD.
    const firstFetchUrl = fetchSpy.mock.calls[0]?.[0];
    expect(firstFetchUrl).toBe(`${FX_API}/v6/latest/USD`);

    // Now the rate is stored — a second call must not fetch again.
    fetchSpy.mockClear();
    const second = await ensureRate(prisma(), "USD", "2026-10-29");
    expect(second).toEqual({ rate: 84.55, live: false, fetched: false });
    expect(fetchSpy).not.toHaveBeenCalled();

    const row = await prisma().fxRate.findUnique({ where: { date_currency: { date: "2026-10-29", currency: "USD" } } });
    expect(row?.rateToInr).toBe(84.55);
    fetchSpy.mockRestore();
  });

  it("falls back to 0 (native-only, flagged) when the live fetch fails and nothing is stored", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const r = await ensureRate(prisma(), "USD", "2026-10-30");
    expect(r).toEqual({ rate: 0, live: false, fetched: false });
    fetchSpy.mockRestore();
  });

  it("falls back to the most recent stored rate when the live fetch fails", async () => {
    await prisma().fxRate.create({ data: { date: "2026-10-20", currency: "USD", rateToInr: 83 } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const r = await ensureRate(prisma(), "USD", "2026-10-30");
    expect(r.rate).toBe(83); // bounded drift, not 0
    fetchSpy.mockRestore();
  });
});

describe("resolveDayRates — per-day map for a pull", () => {
  it("counts live fills but reuses stored rates across days", async () => {
    await prisma().fxRate.create({ data: { date: "2026-10-28", currency: "USD", rateToInr: 84 } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ rates: { INR: 85 } }), { status: 200 });
    });
    const { byDay, liveFills } = await resolveDayRates(prisma(), "USD", ["2026-10-28", "2026-10-29"]);
    expect(byDay.get("2026-10-28")).toBe(84); // stored
    expect(byDay.get("2026-10-29")).toBe(85); // live fill
    expect(liveFills).toBe(1);
    fetchSpy.mockRestore();
  });

  it("INR map is identity with no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { byDay, liveFills } = await resolveDayRates(prisma(), "INR", ["2026-10-28", "2026-10-29"]);
    expect(byDay.get("2026-10-28")).toBe(1);
    expect(liveFills).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Dashboard-V2 §4: multi-source live fetch + native-only INR backfill.
// fetch is mocked so the tests are deterministic + network-free; the source
// chain is routed by its URL shape so the fallback order is asserted.
// ---------------------------------------------------------------------------
function mockFetchBySource(routes: Record<string, () => Promise<Response>>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
    const u = String(url);
    for (const [marker, make] of Object.entries(routes)) {
      if (u.includes(marker)) return make();
    }
    return new Response("unrouted", { status: 404 });
  });
}

describe("fetchLiveFxRate — multi-source fallback (§4)", () => {
  it("returns 1 for INR without touching the network", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await fetchLiveFxRate("INR");
    expect(r).toEqual({ rate: 1, source: "identity", errors: [] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("succeeds on source #1 (open.er-api.com shape)", async () => {
    const spy = mockFetchBySource({
      "open.er-api": () => Promise.resolve(new Response(JSON.stringify({ result: "success", rates: { INR: 84.5 } }), { status: 200 })),
    });
    const r = await fetchLiveFxRate("USD");
    expect(r.rate).toBe(84.5);
    expect(r.source).toBe("open.er-api.com");
    expect(r.errors).toEqual([]);
    spy.mockRestore();
  });

  it("falls back to source #2 (frankfurter.dev) when source #1 fails", async () => {
    const spy = mockFetchBySource({
      "open.er-api": () => Promise.resolve(new Response("boom", { status: 500 })),
      "frankfurter": () => Promise.resolve(new Response(JSON.stringify({ rates: { INR: 85.1 } }), { status: 200 })),
    });
    const r = await fetchLiveFxRate("USD");
    expect(r.rate).toBe(85.1);
    expect(r.source).toBe("frankfurter.dev");
    expect(r.errors).toHaveLength(1); // exactly source #1's failure
    spy.mockRestore();
  });

  it("records the exact error string when ALL THREE sources are unreachable", async () => {
    const spy = mockFetchBySource({
      "open.er-api": () => Promise.reject(new Error("network unreachable")),
      "frankfurter": () => Promise.reject(new Error("timed out")),
      "exchangerate.host": () => Promise.reject(new Error("connection refused")),
    });
    const r = await fetchLiveFxRate("AED");
    expect(r.rate).toBe(0);
    expect(r.source).toBeNull();
    expect(r.errors).toHaveLength(3);
    // The exact per-source strings are surfaced (PO: "never hardcode a fake rate").
    expect(r.errors[0]).toContain("open.er-api.com");
    expect(r.errors[2]).toContain("exchangerate.host");
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// D-09: the bulk inrSpend=0 backfill (money-integrity safety net). INR rows
// stamp the 1:1 identity; a non-INR row converts with its stored per-day rate
// (or the currency's most recent stored rate); no rate + all live sources down
// = BLOCKED with the exact error strings, rows untouched — never a fake rate.
// ---------------------------------------------------------------------------
describe("backfillInrZeroRows — D-09 bulk backfill (idempotent, no fake rates)", () => {
  async function seedSpendRows() {
    const db = await freshDb(); // tenancy: cl_upcurvv + G1 ad-account link row
    const p = db.prisma;
    const cl = await p.client.findFirst();
    const acct = await p.adAccount.findFirst();
    if (!cl || !acct) throw new Error("bootstrap tenancy missing");
    await p.adCampaign.create({ data: { metaId: "d09_cam", adAccountId: acct.id, clientId: cl.id, name: "c", status: "ACTIVE" } });
    await p.adSet.create({ data: { metaId: "d09_set", adAccountId: acct.id, campaignMetaId: "d09_cam", clientId: cl.id, name: "s", status: "ACTIVE" } });
    await p.ad.create({ data: { metaId: "d09_ad", adAccountId: acct.id, adSetMetaId: "d09_set", clientId: cl.id, name: "d09", status: "ACTIVE" } });
    await p.spend.createMany({
      data: [
        // AED native-only money gap: positive spend, no INR yet (rate available per-day).
        { adMetaId: "d09_ad", adAccountId: acct.id, clientId: cl.id, day: "2026-11-01", currency: "AED", spend: 100, inrSpend: 0, inrRate: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, thruPlays: 0 },
        // A zero-spend INR ad-day placeholder (Meta writes these for spend-less days).
        { adMetaId: "d09_ad", adAccountId: acct.id, clientId: cl.id, day: "2026-11-02", currency: "INR", spend: 0, inrSpend: 0, inrRate: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, thruPlays: 0 },
      ],
    });
    return db;
  }

  it("recovers a native-only AED row at its per-day stored rate; stamps an INR zero row 1:1; idempotent", async () => {
    const db = await seedSpendRows();
    const p = db.prisma;
    // The ticket's AED rate, stored for the row's day (open.er-api.com 2026-11-02).
    await p.fxRate.create({ data: { date: "2026-11-01", currency: "AED", rateToInr: 25.849976, source: "open.er-api.com" } });

    const r1 = await backfillInrZeroRows(p);
    expect(r1.scanned).toBe(2);
    expect(r1.recovered).toBe(1); // the AED money row
    expect(r1.rateStamped).toBe(1); // the INR zero-spend row got the 1:1 stamp (value unchanged)
    expect(r1.updates).toBe(2);
    expect(r1.blocked).toHaveLength(0);

    const rows = await p.spend.findMany({ where: { adMetaId: "d09_ad" }, orderBy: { day: "asc" } });
    expect(rows[0].inrSpend).toBe(Math.round(100 * 25.849976 * 100) / 100); // AED → INR
    expect(rows[0].inrRate).toBe(25.849976);
    expect(rows[1].inrRate).toBe(1); // INR identity stamped, not left at 0
    expect(rows[1].inrSpend).toBe(0); // 0 × 1 = 0 — still correct

    // Idempotency: a second run changes nothing. The AED row is no longer
    // inrSpend=0 (it was recovered), so the scan now sees only the zero-spend
    // INR placeholder — and writes nothing (rate already stamped).
    const r2 = await backfillInrZeroRows(p);
    expect(r2.scanned).toBe(1); // only the inrSpend=0 zero-spend row remains
    expect(r2.updates).toBe(0);
    expect(r2.recovered).toBe(0);
    expect(r2.consistent).toBe(1);
    expect(r2.totalInrAfter).toBe(r2.totalInrBefore);
    await db.close();
  });

  it("BLOCKS with the exact FX-source errors (rows untouched, no fake rate) when no stored rate + all sources down", async () => {
    const db = await seedSpendRows();
    const p = db.prisma;
    // No AED FxRate row at all, and every live source is unreachable.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network unreachable"));
    const r = await backfillInrZeroRows(p);
    expect(r.blocked.length).toBeGreaterThan(0);
    expect(r.blocked[0].currency).toBe("AED");
    expect(r.blocked[0].errors).toHaveLength(3); // one exact string per source
    expect(r.blocked[0].errors[0]).toContain("open.er-api.com");
    // The AED money row was NOT touched (no fake rate written).
    const aed = await p.spend.findFirst({ where: { adMetaId: "d09_ad", day: "2026-11-01" } });
    expect(aed?.inrSpend).toBe(0);
    expect(aed?.inrRate).toBe(0);
    spy.mockRestore();
    await db.close();
  });
});

describe("backfillMissingInr — native-only rows (§4)", () => {
  it("re-converts inrSpend=0 native rows once a stored rate exists; a second run is a no-op", async () => {
    // Seeded tenancy (workspace + cl_upcurvv + a G1 ad-account link row) so the
    // ad tree has a valid client + ad account to hang the rows on.
    const db = await freshDb();
    const p = db.prisma;
    const cl = await p.client.findFirst();
    const acct = await p.adAccount.findFirst();
    if (!cl || !acct) throw new Error("bootstrap tenancy missing");

    // A stored AED rate + two native-only AED spend rows on two days
    // ((adMetaId, day) is unique, so one row per day) — inrRate=0, inrSpend=0.
    await p.fxRate.create({ data: { date: "2026-11-01", currency: "AED", rateToInr: 25.85, source: "open.er-api.com" } });
    await p.fxRate.create({ data: { date: "2026-11-02", currency: "AED", rateToInr: 25.85, source: "open.er-api.com" } });
    await p.adCampaign.create({ data: { metaId: "fx_aed_cam", adAccountId: acct.id, clientId: cl.id, name: "c", status: "ACTIVE" } });
    await p.adSet.create({ data: { metaId: "fx_aed_set", adAccountId: acct.id, campaignMetaId: "fx_aed_cam", clientId: cl.id, name: "s", status: "ACTIVE" } });
    await p.ad.create({ data: { metaId: "fx_aed_ad", adAccountId: acct.id, adSetMetaId: "fx_aed_set", clientId: cl.id, name: "AED ad", status: "ACTIVE" } });
    await p.spend.createMany({
      data: [
        { adMetaId: "fx_aed_ad", adAccountId: acct.id, clientId: cl.id, day: "2026-11-01", currency: "AED", spend: 100, inrSpend: 0, inrRate: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, thruPlays: 0 },
        { adMetaId: "fx_aed_ad", adAccountId: acct.id, clientId: cl.id, day: "2026-11-02", currency: "AED", spend: 50, inrSpend: 0, inrRate: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, thruPlays: 0 },
      ],
    });

    const first = await backfillMissingInr(p);
    expect(first.updatedRows).toBe(2);
    const after1 = await p.spend.findMany({ where: { adMetaId: "fx_aed_ad" } });
    expect(after1.map((r) => r.inrSpend).sort()).toEqual([1292.5, 2585]); // 100 & 50 @ 25.85
    expect(after1.every((r) => r.inrRate === 25.85)).toBe(true);

    // Idempotency: a second run finds no inrRate=0 rows left to convert.
    const second = await backfillMissingInr(p);
    expect(second.updatedRows).toBe(0);
    const after2 = await p.spend.findMany({ where: { adMetaId: "fx_aed_ad" } });
    expect(after2.map((r) => r.inrSpend).sort()).toEqual([1292.5, 2585]); // unchanged
    await db.close();
  });
});
