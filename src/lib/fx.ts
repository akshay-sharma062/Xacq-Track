/**
 * FX / currency (spec 5.7).
 *
 * Ad accounts report spend in their native currency (usually USD). We store
 * spend in BOTH the native currency and INR using a stored daily FX rate, so
 * Indian reports and the "matches Meta Ads Manager within 1%" gate don't
 * re-convert at report time (which would drift with the live rate).
 *
 * The store is intentionally simple: a date-keyed rate map. In prod it's backed
 * by a `FxRate` table (see prisma); here it's a plain object so the math is
 * unit-testable with no DB.
 */

export interface FxRate {
  /** date "YYYY-MM-DD" (UTC day the rate applies to). */
  date: string;
  /** 1 unit of `currency` == `rateToInr` INR. */
  currency: string; // ISO-4217, e.g. "USD"
  rateToInr: number;
}

/** Convert a native-currency amount to INR on a given day. */
export function convertToInr(
  amount: number,
  currency: string,
  rates: FxRate[],
  day: string
): number {
  if (currency === "INR") return amount;
  const key = currency.toUpperCase();
  // Most recent rate on or before the day; fall back to latest overall; else 0.
  const dayRates = rates
    .filter((r) => r.currency.toUpperCase() === key)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const chosen =
    dayRates.filter((r) => r.date <= day).slice(-1)[0] ??
    dayRates.slice(-1)[0];
  return chosen ? amount * chosen.rateToInr : 0;
}

/**
 * Record a pulled spend row into a native+INR pair. Returns the row to store.
 * `rate` is the daily FX rate for that day/currency (0 if none — the spend is
 * then stored as native-only and flagged for backfill).
 */
export function storeSpendRow(args: {
  spend: number;
  currency: string;
  rate: number;
}): { inrSpend: number; inrRate: number; currency: string } {
  const { spend, currency, rate } = args;
  return {
    inrSpend: rate === 0 ? 0 : Math.round(spend * rate * 100) / 100,
    inrRate: rate,
    currency: currency.toUpperCase(),
  };
}
