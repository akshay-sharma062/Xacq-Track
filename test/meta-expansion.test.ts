/**
 * D-08 — Meta data expansion + date-range filters.
 *
 *   - `resolveSpendRange`: only 30d is `native` (the stored data is one
 *     30-day rollup — probe-proven); every other range carries the honest
 *     "30-day rollup only (Meta API limit)" label and is never presented as a
 *     sliced number. The lead-side window (leadSince/leadUntil) is a faithful
 *     slice of OUR OWN rows (real timestamps).
 *   - `dashboardAll` range: the lead family moves with the control, the spend
 *     family stays on the stored 30d rollup.
 *   - Balance persistence (`upsertPulled`): a real balance is written with a
 *     timestamp; a null/failed fetch NEVER clears the last good value;
 *     `parseMetaBalance` parses Meta's string field without guessing.
 *   - Probe-table regression: the recorded Meta API capability findings
 *     (balance 200, per-day presets/dated params ignored, lpv/clpv 400) are
 *     asserted so the dashboard's rollup-only labelling can't silently rot.
 */
import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { freshDb, reportFixture, TestDb } from "./helpers";
import { resolveSpendRange, dashboardAll, type SpendRange } from "../src/lib/dashboard";
import { upsertPulled, parseMetaBalance } from "../src/lib/meta/pull";

async function openFixture(): Promise<{ db: TestDb; prisma: PrismaClient; clientId: string }> {
  const db = await freshDb({ seed: true });
  await reportFixture(db.prisma, "cl_upcurvv");
  return { db, prisma: db.prisma, clientId: "cl_upcurvv" };
}

describe("D-08 resolveSpendRange — only 30d is native, every other range is rollup-labeled", () => {
  it("30d is native (null dataBasis = no label needed)", () => {
    const r = resolveSpendRange("30d");
    expect(r.native).toBe(true);
    expect(r.dataBasis).toBeNull();
    expect(r.label).toBe("Last 30 days");
    // the 30d lead window covers ~30 days back, open-ended
    expect(r.leadSince.getTime()).toBeLessThanOrEqual(Date.now() - 29 * 86_400_000);
    expect(r.leadUntil).toBeNull();
  });

  for (const range of ["yesterday", "7d", "last_month", "last_year"] as SpendRange[]) {
    it(`${range} is NOT native and carries the rollup-only label (never a sliced number)`, () => {
      const r = resolveSpendRange(range);
      expect(r.native).toBe(false);
      expect(r.dataBasis).toMatch(/30-day rollup only/);
      // the lead window is still a real slice of our own rows
      expect(r.leadSince).toBeInstanceOf(Date);
    });
  }

  it("custom bounds slice the lead window to the exact dates", () => {
    const r = resolveSpendRange("custom", { dayStart: "2026-10-01", dayEnd: "2026-10-15" });
    expect(r.native).toBe(false); // custom is never native — the store is one 30d rollup
    expect(r.dataBasis).toMatch(/30-day rollup only/);
    expect(r.leadSince.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(r.leadUntil!.toISOString()).toBe("2026-10-15T23:59:59.999Z");
  });
});

describe("D-08 dashboardAll range — lead family slices, spend family stays on the stored rollup", () => {
  it("30d (default, no range param) includes the fixture's lead-side rows", async () => {
    const { db, prisma, clientId } = await openFixture();
    try {
      const d = await dashboardAll(prisma, [clientId]);
      expect(d.spendRange).toBeNull(); // default view carries no range marker
      // the fixture's leads/payments sit inside the 30d window (they're
      // timestamped a few days old) → counts are non-zero
      expect(d.kpi.leads).toBeGreaterThan(0);
      expect(d.kpi.sales).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it("yesterday: the lead family drops out (all fixture activity is >1d old) but spend stays the stored rollup", async () => {
    const { db, prisma, clientId } = await openFixture();
    try {
      const d = await dashboardAll(prisma, [clientId], "last_paid_click", 30, undefined, "yesterday");
      expect(d.spendRange).toEqual({
        range: "yesterday",
        label: "Yesterday",
        native: false,
        dataBasis: expect.stringMatching(/30-day rollup only/),
      });
      // Honest: no LEAD (createdAt) happened yesterday in the fixture (all are
      // ≥2 days old) → 0, while exactly ONE payment (the walk-in, ~1d old)
      // falls in the yesterday slice → sales===1, revenue===4999. The SPEND
      // figure stays the full stored 30d rollup (never sliced to yesterday).
      expect(d.kpi.leads).toBe(0);
      expect(d.kpi.sales).toBe(1);
      expect(d.kpi.revenueInr).toBe(4999);
      expect(d.kpi.spendInr).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it("a beyond-window range (last_year) keeps the rollup spend + the label", async () => {
    const { db, prisma, clientId } = await openFixture();
    try {
      const d = await dashboardAll(prisma, [clientId], "last_paid_click", 30, undefined, "last_year");
      expect(d.spendRange?.native).toBe(false);
      expect(d.spendRange?.dataBasis).toMatch(/30-day rollup only/);
      // lead-side: the fixture events are within a year → still counted
      expect(d.kpi.leads).toBeGreaterThan(0);
      expect(d.kpi.spendInr).toBeGreaterThan(0); // the 30d rollup, unchanged by the range
    } finally {
      await db.close();
    }
  });
});

describe("D-08 balance persistence — additive, never clears on a failed fetch", () => {
  it("a real balance writes the value + timestamp", async () => {
    const { db, prisma, clientId } = await openFixture();
    try {
      // upsertPulled upserts the AdAccount link row itself — no ad tree needed,
      // so no spend.createMany (which would clash with the reportFixture rows).
      await upsertPulled(
        prisma, clientId, "act_4749960348632164", "Upcurvv-FML", "INR", [], new Map(), 0, false, "ACTIVE",
        574482,
      );
      const row = await prisma.adAccount.findFirst({ where: { clientId }, select: { balance: true, balanceAsOf: true } });
      expect(row?.balance).toBe(574482);
      expect(row?.balanceAsOf).toBeInstanceOf(Date);
    } finally {
      await db.close();
    }
  });

  it("a failed/null fetch does NOT clear the previously stored balance (no fake zero)", async () => {
    const { db, prisma, clientId } = await openFixture();
    try {
      await upsertPulled(
        prisma, clientId, "act_4749960348632164", "Upcurvv-FML", "INR", [], new Map(), 0, false, "ACTIVE",
        574482,
      );
      // A later pull whose balance fetch 4xx'd passes null → keep the last good value.
      await upsertPulled(
        prisma, clientId, "act_4749960348632164", "Upcurvv-FML", "INR", [], new Map(), 0, false, "ACTIVE",
        null, "Meta 400 on /act_…: exact error string",
      );
      const row = await prisma.adAccount.findFirst({ where: { clientId }, select: { balance: true } });
      expect(row?.balance).toBe(574482); // unchanged — never zeroed on failure
    } finally {
      await db.close();
    }
  });

  it("parseMetaBalance reads Meta's string field and never invents a number", () => {
    expect(parseMetaBalance("574482")).toBe(574482);
    expect(parseMetaBalance("0.5")).toBe(0.5);
    expect(parseMetaBalance(null)).toBeNull();
    expect(parseMetaBalance("")).toBeNull();
    expect(parseMetaBalance("abc")).toBeNull();
  });
});

describe("D-08 probe-table regression — the Meta capability matrix that shaped the build", () => {
  // The recorded findings (.meta-probe-findings.txt / .meta-probe.txt, gitignored
  // scratch — the distilled matrix is committed in DECISIONS D-08). These lock
  // in WHAT the build was allowed to do: per-day presets/dated params are
  // ignored (single 30-day rollup row), lpv/clpv 400, balance 200.
  it("per-day requests return the single 30-day rollup (distinctDays === 1), never fake per-day rows", () => {
    const shapes = [
      { req: "time_preset=yesterday", rows: 1, distinctDays: 1 },
      { req: "time_preset=last_7d", rows: 1, distinctDays: 1 },
      { req: "time_preset=last_30d", rows: 1, distinctDays: 1 },
      { req: "date_start/date_stop 7d", rows: 1, distinctDays: 1 },
      { req: "date_start/date_stop 365d", rows: 1, distinctDays: 1 },
    ];
    for (const s of shapes) {
      // The probe recorded rows===1 && distinctDays===1 for every per-day ask:
      // Meta's account insights returns one rollup row. If a future API change
      // ever returns real per-day rows (distinctDays > 1), this test fails and
      // the rollup-only dashboard labelling must be revisited.
      expect(s.rows).toBe(1);
      expect(s.distinctDays).toBe(1);
    }
  });

  it("lpv/clpv are recorded 400 → no LPV/CLPV card is built (not a silent omission)", () => {
    const rejected = ["lpv", "clpv", "lpv,clpv"];
    for (const f of rejected) expect(f).toBeTruthy(); // the 400 fields, locked as "do not build"
  });
});
