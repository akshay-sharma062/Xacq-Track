import { describe, it, expect } from "vitest";
import { convertToInr, storeSpendRow, FxRate } from "../src/lib/fx";

const rates: FxRate[] = [
  { date: "2024-04-01", currency: "USD", rateToInr: 80 },
  { date: "2024-04-10", currency: "USD", rateToInr: 84 },
  { date: "2024-04-01", currency: "EUR", rateToInr: 87 },
];

describe("fx — convertToInr (spec 5.7: stored daily rate, no live drift)", () => {
  it("INR is identity", () => {
    expect(convertToInr(100, "INR", rates, "2024-04-15")).toBe(100);
  });
  it("uses the most recent rate on-or-before the day", () => {
    expect(convertToInr(10, "USD", rates, "2024-04-15")).toBe(10 * 84); // 04-10 rate
    expect(convertToInr(10, "USD", rates, "2024-04-05")).toBe(10 * 80); // 04-01 rate
  });
  it("falls back to the latest rate when the day is before all rates", () => {
    expect(convertToInr(10, "USD", rates, "2024-01-01")).toBe(10 * 84);
  });
  it("unknown currency -> 0 (flagged for backfill, not a crash)", () => {
    expect(convertToInr(10, "JPY", rates, "2024-04-15")).toBe(0);
  });
});

describe("fx — storeSpendRow (native + INR pair, spec 5.7)", () => {
  it("stores inrSpend = spend * rate, rounded to 2dp", () => {
    const r = storeSpendRow({ spend: 900, currency: "usd", rate: 84 });
    expect(r.inrSpend).toBe(Math.round(900 * 84 * 100) / 100);
    expect(r.inrRate).toBe(84);
    expect(r.currency).toBe("USD"); // upper-cased
  });
  it("zero rate -> inrSpend 0 (native-only, flagged)", () => {
    expect(storeSpendRow({ spend: 900, currency: "USD", rate: 0 }).inrSpend).toBe(0);
  });
});
