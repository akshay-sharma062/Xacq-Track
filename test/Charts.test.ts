import { describe, it, expect } from "vitest";
import { CountUp } from "../src/app/components/CountUp";
import { DonutChart, LineChart, BarChartV2, AreaChart, GaugeChart } from "../src/app/components/Charts";
import { useAnimate } from "../src/app/components/useAnimate";

/**
 * D-20 — smoke tests for the new "use client" chart/counter components.
 *
 * These are client components (they mount Chart.js / run rAF loops in a
 * browser), so under the Node vitest environment we only assert they are
 * valid React component modules (function components) that export correctly —
 * "renders without crashing" in the sense of: the module loads and the
 * component identity is a function (or memo/forwardRef object), which is the
 * invariant the dashboard relies on to render them.
 */

function isReactComponent(x: unknown): boolean {
  if (typeof x === "function") return true;
  // forwardRef / memo components are objects with a $$typeof symbol.
  return typeof x === "object" && x !== null && "$$typeof" in (x as object);
}

describe("D-20 chart/counter components export as valid React components", () => {
  it("CountUp", () => expect(isReactComponent(CountUp)).toBe(true));
  it("DonutChart", () => expect(isReactComponent(DonutChart)).toBe(true));
  it("LineChart", () => expect(isReactComponent(LineChart)).toBe(true));
  it("BarChartV2", () => expect(isReactComponent(BarChartV2)).toBe(true));
  it("AreaChart", () => expect(isReactComponent(AreaChart)).toBe(true));
  it("GaugeChart", () => expect(isReactComponent(GaugeChart)).toBe(true));
  it("useAnimate", () => expect(typeof useAnimate).toBe("function"));
});
