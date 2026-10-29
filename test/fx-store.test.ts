import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { freshDb } from "./helpers";
import { ensureRate, resolveDayRates, FX_API } from "../src/lib/fx-store";
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
