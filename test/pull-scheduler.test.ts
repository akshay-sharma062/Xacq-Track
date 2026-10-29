import { describe, it, expect } from "vitest";
import { cadenceForHour, daysForCadence } from "../src/jobs/pull-scheduler";

/**
 * Spec 5.7 cadence: "Every night and every 3 hours during the day."
 * Nightly = 02:00 IST backfill (30d, refreshes the report window); daytime =
 * 07,10,13,16,19,22 (1d, re-pull today as spend accrues). Pure function, so
 * the whole schedule is unit-testable without a timer or a live process.
 */
describe("pull-scheduler cadence (spec 5.7)", () => {
  it.each([
    [2, "backfill30"],
    [7, "daily1"],
    [10, "daily1"],
    [13, "daily1"],
    [16, "daily1"],
    [19, "daily1"],
    [22, "daily1"],
  ] as const)("hour %i -> %s", (h, c) => {
    expect(cadenceForHour(h)).toBe(c);
  });

  it("no pull in the idle hours (0,1,3..6,23)", () => {
    for (const h of [0, 1, 3, 4, 5, 6, 23]) expect(cadenceForHour(h)).toBeNull();
  });

  it("days-for-cadence: nightly 30d backfill, daytime 1d", () => {
    expect(daysForCadence("backfill30")).toBe(30);
    expect(daysForCadence("daily1")).toBe(1);
  });

  it("every firing hour across a 24h cycle is covered exactly once", () => {
    const fired: number[] = [];
    for (let h = 0; h < 24; h++) if (cadenceForHour(h)) fired.push(h);
    expect(fired).toEqual([2, 7, 10, 13, 16, 19, 22]);
  });
});
