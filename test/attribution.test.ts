import { describe, it, expect } from "vitest";
import {
  attributeSale,
  countAdClicks,
  firstAdClicked,
  lastAdClicked,
  aggregateAttribution,
} from "../src/lib/attribution";
import type { AdClickTouchpoint } from "../src/lib/types";

const now = 1_700_000_000_000; // a fixed epoch-ms anchor
const day = 86_400_000;

function click(adId: string, daysAgo: number, extra: Partial<AdClickTouchpoint> = {}): AdClickTouchpoint {
  return { ts: now - daysAgo * day, adId, ...extra };
}

describe("attribution — last_paid_click (default, spec 7)", () => {
  it("credits the most recent in-window ad click", () => {
    const res = attributeSale({
      model: "last_paid_click",
      windowDays: 30,
      saleTime: now,
      clicks: [click("ad_old", 25), click("ad_new", 2)],
    });
    expect(res.attributed).toBe(true);
    expect(res.primaryAdId).toBe("ad_new");
    expect(res.credits).toHaveLength(1);
    expect(res.credits[0]!.share).toBe(1);
  });

  it("ad click older than the window is excluded", () => {
    const res = attributeSale({
      model: "last_paid_click",
      windowDays: 7,
      saleTime: now,
      clicks: [click("ad_old", 30)],
    });
    expect(res.organic).toBe(true);
    expect(res.credits).toHaveLength(0);
  });

  it("no clicks -> organic (spec 7: 'Organic / unknown')", () => {
    const res = attributeSale({
      model: "last_paid_click",
      windowDays: 30,
      saleTime: now,
      clicks: [],
    });
    expect(res.organic).toBe(true);
    expect(res.primaryAdId).toBeNull();
  });
});

describe("attribution — first_click (spec 7)", () => {
  it("credits the earliest in-window click", () => {
    const res = attributeSale({
      model: "first_click",
      windowDays: 60,
      saleTime: now,
      clicks: [click("ad_a", 40), click("ad_b", 5)],
    });
    expect(res.primaryAdId).toBe("ad_a");
  });
});

describe("attribution — linear (spec 7: split equally)", () => {
  it("splits equally across distinct ads, sums to 1", () => {
    const res = attributeSale({
      model: "linear",
      windowDays: 30,
      saleTime: now,
      // Two clicks on ad_a, one on ad_b -> 2 distinct ads.
      clicks: [click("ad_a", 20), click("ad_a", 10), click("ad_b", 5)],
    });
    const shares = res.credits.map((c) => c.share).reduce((s, v) => s + v, 0);
    expect(res.credits).toHaveLength(2);
    expect(shares).toBeCloseTo(1, 5);
    for (const c of res.credits) expect(c.share).toBeCloseTo(0.5, 5);
  });
});

describe("attribution — lead_source (spec 7: ad on first form fill)", () => {
  it("credits the ad on the lead's first form fill, ignoring later clicks", () => {
    const res = attributeSale({
      model: "lead_source",
      windowDays: 30,
      saleTime: now,
      clicks: [click("ad_later", 3)],
      firstFormFill: click("ad_first", 20),
    });
    expect(res.primaryAdId).toBe("ad_first");
  });

  it("falls back to organic when the first form fill had no ad", () => {
    const res = attributeSale({
      model: "lead_source",
      windowDays: 30,
      saleTime: now,
      clicks: [click("ad_later", 3)],
      firstFormFill: { ts: now - 20 * day, adId: null },
    });
    expect(res.organic).toBe(true);
  });
});

describe("attribution — click helpers (spec 3: 'how many times they clicked')", () => {
  const clicks = [click("a", 10), click("b", 5), { ts: now, adId: null }, click("c", 1)];
  it("countAdClicks ignores ad-less touchpoints", () => {
    expect(countAdClicks(clicks)).toBe(3);
  });
  it("firstAdClicked / lastAdClicked return the correct edges", () => {
    expect(firstAdClicked(clicks)?.adId).toBe("a");
    expect(lastAdClicked(clicks)?.adId).toBe("c");
  });
});

describe("attribution — aggregation (spec 7: roll up to ad/adset/campaign)", () => {
  it("last-click: full amount to one ad, organic bucket separate", () => {
    const buckets = aggregateAttribution(
      {
        model: "last_paid_click",
        windowDays: 30,
        sales: [
          { leadId: "l1", saleTime: now, amount: 10000, clicks: [click("ad_x", 3)] },
          { leadId: "l2", saleTime: now, amount: 5000, clicks: [click("ad_y", 2)] },
          { leadId: "l3", saleTime: now, amount: 2000, clicks: [] }, // organic
        ],
      },
      "ad"
    );
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    expect(byKey.ad_x!.revenue).toBe(10000);
    expect(byKey.ad_y!.revenue).toBe(5000);
    expect(byKey.organic!.revenue).toBe(2000);
    expect(byKey.organic!.label).toBe("Organic / unknown");
  });

  it("linear: fractional revenue spread across ads", () => {
    const buckets = aggregateAttribution(
      {
        model: "linear",
        windowDays: 30,
        sales: [
          { leadId: "l1", saleTime: now, amount: 100, clicks: [click("ad_x", 5), click("ad_y", 2)] },
        ],
      },
      "ad"
    );
    const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
    // 100 split across 2 ads -> 50 each (shareRevenue), and revenue also 50 each.
    expect(byKey.ad_x!.shareRevenue).toBeCloseTo(50);
    expect(byKey.ad_y!.shareRevenue).toBeCloseTo(50);
  });
});
