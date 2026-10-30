import { describe, it, expect } from "vitest";
import { cadenceForHour } from "../src/jobs/pull-scheduler";
import { normalizeAdAccountRef, resultsToConversions } from "../src/lib/meta/pull";

/**
 * Spec 5.7 cadence: "Every night and every 3 hours during the day."
 * 02:00 = nightly slot; 07,10,13,16,19,22 = every-3h daytime slots. Pure
 * function, so the whole schedule is unit-testable without a timer or a live
 * process. (G1: both slots pull Meta's no-range 30-day rollup, so the label
 * drives dedup + logs, not a day count.)
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

  it("every firing hour across a 24h cycle is covered exactly once", () => {
    const fired: number[] = [];
    for (let h = 0; h < 24; h++) if (cadenceForHour(h)) fired.push(h);
    expect(fired).toEqual([2, 7, 10, 13, 16, 19, 22]);
  });
});

describe("normalizeAdAccountRef (G1 live verification: bare numbers 404 without act_)", () => {
  it("adds the act_ prefix to a bare numeric id", () => {
    expect(normalizeAdAccountRef("4749960348632164")).toBe("act_4749960348632164");
  });
  it("keeps an already-prefixed ref untouched", () => {
    expect(normalizeAdAccountRef("act_4749960348632164")).toBe("act_4749960348632164");
  });
  it("strips stray quotes/whitespace (the real .env hygiene bug from G1)", () => {
    expect(normalizeAdAccountRef(`"4749960348632164`)).toBe("act_4749960348632164");
    expect(normalizeAdAccountRef("  4749960348632164  ")).toBe("act_4749960348632164");
  });
  it("returns empty for empty input", () => {
    expect(normalizeAdAccountRef("   ")).toBe("");
  });
});

describe("resultsToConversions (spec 7: Meta-reported conversions proxy)", () => {
  it("sums the values of a results[] payload", () => {
    expect(resultsToConversions([{ indicator: "a", value: "3" }, { indicator: "b", value: 2 }])).toBe(5);
  });
  it("is 0 for missing / non-array / malformed payloads", () => {
    expect(resultsToConversions(undefined)).toBe(0);
    expect(resultsToConversions(null)).toBe(0);
    expect(resultsToConversions([{ value: "not-a-number" }])).toBe(0);
  });
});
