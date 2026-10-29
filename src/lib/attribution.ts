/**
 * Attribution (spec section 7).
 *
 * Every sale is credited to ad(s) by a fixed, selectable rule; every report
 * states which rule it used. The window is editable per client (7/14/30/60
 * days, default 30 for last-paid-click). A sale with no ad click inside the
 * window is credited to "Organic / unknown".
 *
 * Four models:
 *   last_paid_click (default) -> last ad clicked before the sale, in window.
 *   first_click               -> first ad clicked in window (who found them).
 *   linear                    -> split equally across distinct ads clicked.
 *   lead_source               -> the ad on the lead's FIRST form fill.
 *
 * Pure + deterministic so a report replay is byte-stable (spec rule 8 / H).
 */
import { AttributionModel, AdClickTouchpoint } from "./types";

const DAY_MS = 86_400_000;

export interface AttributionInput {
  model: AttributionModel;
  windowDays: number; // 7 | 14 | 30 | 60
  saleTime: number; // epoch ms
  clicks: AdClickTouchpoint[]; // all ad-click touchpoints for the lead
  // The first form-fill touchpoint (may carry an ad) — used by lead_source.
  firstFormFill?: AdClickTouchpoint | null;
}

export interface AttributionCredit {
  adId: string;
  adName: string | null;
  adsetId: string | null;
  campaignId: string | null;
  /** share of the sale's credit, 0..1 (sums to 1 across credits). */
  share: number;
}

export interface AttributionResult {
  model: AttributionModel;
  windowDays: number;
  /** false only when there was no ad click in the window -> organic. */
  attributed: boolean;
  organic: boolean;
  credits: AttributionCredit[];
  /** For point models the single credited ad; for linear the top ad. */
  primaryAdId: string | null;
  reason: string;
}

function inWindow(c: AdClickTouchpoint, saleTime: number, windowDays: number): boolean {
  const cutoff = saleTime - windowDays * DAY_MS;
  return c.ts >= cutoff && c.ts <= saleTime;
}

function creditFrom(c: AdClickTouchpoint, share: number): AttributionCredit {
  return {
    adId: c.adId as string,
    adName: c.adName ?? null,
    adsetId: c.adsetId ?? null,
    campaignId: c.campaignId ?? null,
    share,
  };
}

/**
 * Attribute a single sale to ad(s). Returns an `AttributionResult` that always
 * has `credits` summing to 1 (or empty + `organic:true` when nothing in-window).
 */
export function attributeSale(input: AttributionInput): AttributionResult {
  const { model, windowDays, saleTime, clicks } = input;
  const qualified = clicks.filter(
    (c) => c.adId && inWindow(c, saleTime, windowDays)
  );

  // lead_source: credit the ad on the lead's first form fill (if it has one).
  if (model === "lead_source") {
    const ff = input.firstFormFill;
    if (ff && ff.adId && inWindow(ff, saleTime, windowDays)) {
      return {
        model,
        windowDays,
        attributed: true,
        organic: false,
        credits: [creditFrom(ff, 1)],
        primaryAdId: ff.adId,
        reason: "lead_source: ad on the lead's first form fill (in window).",
      };
    }
    return organic(model, windowDays, "lead_source: first form fill had no ad in window.");
  }

  if (qualified.length === 0) {
    return organic(model, windowDays, "no ad click within the window.");
  }

  if (model === "last_paid_click") {
    const last = qualified.reduce((a, b) => (a.ts > b.ts ? a : b));
    return {
      model,
      windowDays,
      attributed: true,
      organic: false,
      credits: [creditFrom(last, 1)],
      primaryAdId: last.adId ?? null,
      reason: "last_paid_click: most recent ad click before the sale (in window).",
    };
  }

  if (model === "first_click") {
    const first = qualified.reduce((a, b) => (a.ts < b.ts ? a : b));
    return {
      model,
      windowDays,
      attributed: true,
      organic: false,
      credits: [creditFrom(first, 1)],
      primaryAdId: first.adId ?? null,
      reason: "first_click: earliest ad click that brought the person in.",
    };
  }

  // linear: split equally across DISTINCT ads clicked in the window.
  const byAd = new Map<string, AdClickTouchpoint>();
  for (const c of qualified) byAd.set(c.adId as string, c);
  const ads = [...byAd.values()];
  const share = 1 / ads.length;
  const credits = ads.map((c) => creditFrom(c, share));
  const primary = credits.reduce((a, b) => (a.share > b.share ? a : b));
  return {
    model,
    windowDays,
    attributed: true,
    organic: false,
    credits,
    primaryAdId: primary.adId,
    reason: `linear: credit split ${share.toFixed(3)} across ${ads.length} distinct ad(s).`,
  };
}

function organic(
  model: AttributionModel,
  windowDays: number,
  reason: string
): AttributionResult {
  return {
    model,
    windowDays,
    attributed: false,
    organic: true,
    credits: [],
    primaryAdId: null,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Helpers used by the source card + reports (spec 3).
// ---------------------------------------------------------------------------

/** "How many times they clicked our ads" = count of ad-click touchpoints. */
export function countAdClicks(clicks: AdClickTouchpoint[]): number {
  return clicks.filter((c) => c.adId).length;
}

/** The ad that first brought the person in (earliest ad click, any time). */
export function firstAdClicked(clicks: AdClickTouchpoint[]): AdClickTouchpoint | null {
  const withAd = clicks.filter((c) => c.adId);
  if (withAd.length === 0) return null;
  return withAd.reduce((a, b) => (a.ts <= b.ts ? a : b));
}

/** The most recent ad click (any time, not windowed). */
export function lastAdClicked(clicks: AdClickTouchpoint[]): AdClickTouchpoint | null {
  const withAd = clicks.filter((c) => c.adId);
  if (withAd.length === 0) return null;
  return withAd.reduce((a, b) => (a.ts >= b.ts ? a : b));
}

// ---------------------------------------------------------------------------
// Aggregation: roll ad-level credits up to ad / adset / campaign / client.
// Used by the ad-performance + funnel reports.
// ---------------------------------------------------------------------------
export interface AttributionAggInput {
  sales: {
    leadId: string;
    saleTime: number;
    amount: number; // INR
    currency?: string;
    clicks: AdClickTouchpoint[];
    firstFormFill?: AdClickTouchpoint | null;
  }[];
  model: AttributionModel;
  windowDays: number;
}

export type AdLevel = "ad" | "adset" | "campaign" | "organic";

export interface AttributionBucket {
  key: string; // adId / adsetId / campaignId / "organic"
  label: string;
  revenue: number;
  sales: number; // number of sales fully or partially credited
  shareRevenue: number; // revenue * share (for linear this is fractional credit)
}

/**
 * Credit each sale via `attributeSale` and bucket by `level`. Linear credits
 * contribute their fractional revenue to every ad they touch; point models
 * contribute the full amount to the one credited ad. Organic falls into a
 * single "Organic / unknown" bucket.
 */
export function aggregateAttribution(
  input: AttributionAggInput,
  level: AdLevel = "ad"
): AttributionBucket[] {
  const buckets = new Map<string, AttributionBucket>();

  const ensure = (key: string, label: string): AttributionBucket => {
    let b = buckets.get(key);
    if (!b) {
      b = { key, label, revenue: 0, sales: 0, shareRevenue: 0 };
      buckets.set(key, b);
    }
    return b;
  };

  for (const sale of input.sales) {
    const res = attributeSale({
      model: input.model,
      windowDays: input.windowDays,
      saleTime: sale.saleTime,
      clicks: sale.clicks,
      firstFormFill: sale.firstFormFill,
    });

    if (res.organic || res.credits.length === 0) {
      const b = ensure("organic", "Organic / unknown");
      b.revenue += sale.amount;
      b.shareRevenue += sale.amount;
      b.sales += 1;
      continue;
    }

    const isLinear = input.model === "linear";
    for (const c of res.credits) {
      const key =
        level === "ad" ? c.adId : level === "adset" ? c.adsetId : level === "campaign" ? c.campaignId : c.adId;
      const label = level === "ad" ? c.adName ?? c.adId : c.adId ?? c.adsetId ?? c.campaignId;
      if (!key || key === "organic") continue;
      const b = ensure(key, label ?? key);
      b.shareRevenue += sale.amount * c.share;
      // Linear credits are fractional; point models credit the full amount.
      b.revenue += isLinear ? sale.amount * c.share : sale.amount;
      // Count a sale once per bucket it touches.
      if (res.credits.length === 1) b.sales += 1;
    }
  }

  return [...buckets.values()].sort((a, b) => b.shareRevenue - a.shareRevenue);
}
