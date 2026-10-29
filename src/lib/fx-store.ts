/**
 * DB-backed daily FX rates (spec 5.7: "store spend in billing currency and in
 * INR, using a stored daily FX rate"). The pure math stays in `fx.ts`; this
 * module owns the FxRate table: look up the stored rate for (day, currency),
 * and when it's missing, fetch the live rate once, persist it, and return it.
 *
 * Live fetch uses open.er-api.com (no API key):
 *   GET https://open.er-api.com/v6/latest/USD  ->  { rates: { INR: 84.3, … } }
 * The fetched value is stored so reports NEVER re-convert at report time
 * (no live-rate drift — spec 5.7).
 */
import { PrismaClient } from "./prisma";

export const FX_API = process.env.FX_API_BASE ?? "https://open.er-api.com";

/**
 * Rate for `currency → INR` on `day` ("YYYY-MM-DD"), stored when known.
 * Fetches live (and persists) on a miss; returns 0 + flagged when the live
 * fetch also fails (the spend row is then native-only, per `fx.storeSpendRow`).
 */
export async function ensureRate(
  prisma: PrismaClient,
  currency: string,
  day: string
): Promise<{ rate: number; live: boolean; fetched: boolean }> {
  const cur = currency.toUpperCase();
  if (cur === "INR") return { rate: 1, live: false, fetched: false };

  const stored = await prisma.fxRate.findUnique({
    where: { date_currency: { date: day, currency: cur } },
  });
  if (stored) return { rate: stored.rateToInr, live: false, fetched: false };

  // Live fetch + persist (first writer wins; the unique index guards races).
  // open.er-api returns "1 unit of base currency -> rates in others", so
  // fetch `cur` as the base and read its INR rate: 1 `cur` = rates.INR ₹.
  try {
    const res = await fetch(`${FX_API}/v6/latest/${cur}`);
    const json: any = await res.json();
    const rate: number = json?.rates?.INR;
    if (typeof rate !== "number" || rate <= 0) throw new Error("bad fx payload");
    await prisma.fxRate.upsert({
      where: { date_currency: { date: day, currency: cur } },
      update: {},
      create: { date: day, currency: cur, rateToInr: rate },
    });
    return { rate, live: true, fetched: true };
  } catch {
    // Fall back to the most recent stored rate of any day (bounded drift is
    // acceptable for a missed fetch; 0 = native-only, flagged for backfill).
    const fallback = await prisma.fxRate.findFirst({
      where: { currency: cur },
      orderBy: { date: "desc" },
    });
    return { rate: fallback?.rateToInr ?? 0, live: false, fetched: false };
  }
}

/**
 * Resolve a per-day rate map for a pull: stored rates where present, live
 * fills where missing. Returns `day → rate` and whether any day needed a live
 * fetch (for the pull result summary).
 */
export async function resolveDayRates(
  prisma: PrismaClient,
  currency: string,
  days: string[]
): Promise<{ byDay: Map<string, number>; liveFills: number }> {
  const byDay = new Map<string, number>();
  let liveFills = 0;
  const cur = currency.toUpperCase();
  if (cur === "INR") {
    days.forEach((d) => byDay.set(d, 1));
    return { byDay, liveFills };
  }
  for (const day of new Set(days)) {
    const r = await ensureRate(prisma, cur, day);
    byDay.set(day, r.rate);
    if (r.fetched) liveFills++;
  }
  return { byDay, liveFills };
}
