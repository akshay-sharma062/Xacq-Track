/**
 * DB-backed daily FX rates (spec 5.7: "store spend in billing currency and in
 * INR, using a stored daily FX rate"). The pure math stays in `fx.ts`; this
 * module owns the FxRate table: look up the stored rate for (day, currency),
 * and when it's missing, fetch the live rate, persist it, and return it.
 *
 * Multi-source live fetch with a documented fallback order (Dashboard-V2 §4):
 *   1. open.er-api.com        GET /v6/latest/{CUR}                 -> rates.INR
 *   2. frankfurter.dev        GET /v1/latest?from={CUR}&to=INR     -> rates.INR
 *   3. exchangerate.host      GET /latest?base={CUR}&symbols=INR   -> rates.INR
 * Each base URL is env-overridable (FX_API_BASE / FX_API_FRANKFURTER /
 * FX_API_EXCHANGERATE_HOST) so tests can point them at a mock. The winning
 * source's name is stored on the FxRate row (spec: record (date, currency,
 * rate, source)). INR accounts are identity (1:1) and never fetch.
 *
 * If ALL THREE sources are unreachable, the rate stays 0 → the spend row is
 * native-only and flagged for backfill (spec 5.7 documented fallback). We
 * NEVER hardcode a fake rate. `backfillMissingInr()` re-attempts the fetch +
 * re-converts the native-only rows once a source becomes reachable (the AED
 * gap the PO called out).
 */
import { PrismaClient } from "./prisma";

// Source 1 — historical default (kept first, env-overridable, so the existing
// "fills live on a miss" test still sees `${FX_API}/v6/latest/{CUR}` first).
export const FX_API = process.env.FX_API_BASE ?? "https://open.er-api.com";
export const FX_API_FRANKFURTER = process.env.FX_API_FRANKFURTER ?? "https://api.frankfurter.dev";
export const FX_API_EXCHANGERATE_HOST = process.env.FX_API_EXCHANGERATE_HOST ?? "https://api.exchangerate.host";

/** One source in the fallback chain. `parse` reads the 1-unit-of-base rate. */
interface FxSource {
  name: string;
  url: (cur: string) => string;
  parse: (json: any) => number | undefined;
}

const FX_SOURCES: FxSource[] = [
  { name: "open.er-api.com", url: (cur) => `${FX_API}/v6/latest/${cur}`, parse: (j) => j?.rates?.INR },
  { name: "frankfurter.dev", url: (cur) => `${FX_API_FRANKFURTER}/v1/latest?from=${cur}&to=INR`, parse: (j) => j?.rates?.INR },
  { name: "exchangerate.host", url: (cur) => `${FX_API_EXCHANGERATE_HOST}/latest?base=${cur}&symbols=INR`, parse: (j) => j?.rates?.INR },
];

export interface LiveFxResult {
  rate: number; // 0 when every source failed (native-only, flagged)
  source: string | null; // the source that produced `rate`
  errors: string[]; // one entry per failed source (the "exact error strings")
}

/**
 * Fetch the live `currency → INR` rate, trying each source in the fallback
 * order. Returns the first source that yields a positive rate; if none do,
 * returns rate 0 with every source's failure recorded (for the honest
 * "FX: BLOCKED: network" surfacing — never a hardcoded fake rate).
 */
export async function fetchLiveFxRate(currency: string): Promise<LiveFxResult> {
  const cur = currency.toUpperCase();
  if (cur === "INR") return { rate: 1, source: "identity", errors: [] };
  const errors: string[] = [];
  for (const src of FX_SOURCES) {
    try {
      const res = await fetch(src.url(cur));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = await res.json();
      const rate = src.parse(json);
      if (typeof rate !== "number" || !(rate > 0)) throw new Error("bad fx payload");
      return { rate, source: src.name, errors };
    } catch (e: any) {
      errors.push(`${src.name}: ${String(e?.message ?? e)}`);
    }
  }
  return { rate: 0, source: null, errors };
}

/**
 * Rate for `currency → INR` on `day` ("YYYY-MM-DD"), stored when known.
 * Returns the shape the pull pipeline + existing tests rely on
 * (`{ rate, live, fetched }`): stored-first, live-fill-once-and-persist on a
 * miss, most-recent-stored fallback (bounded drift) else 0. The winning live
 * source is recorded on the persisted FxRate row (`source`), not on the
 * return value, so the public shape stays stable.
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

  // Live fetch (multi-source, first positive wins) + persist; record source.
  const live = await fetchLiveFxRate(cur);
  if (live.rate > 0) {
    await prisma.fxRate.upsert({
      where: { date_currency: { date: day, currency: cur } },
      update: {},
      create: { date: day, currency: cur, rateToInr: live.rate, source: live.source ?? "unknown" },
    });
    return { rate: live.rate, live: true, fetched: true };
  }

  // All sources failed: fall back to the most recent stored rate of any day
  // (bounded drift is acceptable for a missed fetch; 0 = native-only,
  // flagged for backfill — never a hardcoded fake rate).
  const fallback = await prisma.fxRate.findFirst({
    where: { currency: cur },
    orderBy: { date: "desc" },
  });
  return { rate: fallback?.rateToInr ?? 0, live: false, fetched: false };
}

/**
 * Resolve a per-day rate map for a pull: stored rates where present, live
 * fills where missing. Returns `day → rate` and whether any day needed a live
 * fetch (for the pull result summary). Shape unchanged from the G1 version.
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

export interface BackfillResult {
  currencies: string[]; // non-INR currencies that had native-only rows
  days: string[]; // (currency,day) pairs that got a rate
  updatedRows: number; // spend rows re-converted to INR this run
  rates: { currency: string; day: string; rate: number; source: string | null }[];
}

/**
 * D-09 — bulk backfill over EVERY `inrSpend=0` Spend row (money-integrity
 * safety net), stronger than `backfillMissingInr` (which only touches
 * non-INR `spend>0` rows):
 *
 *   - INR rows: identity — `inrSpend := spend` (rate 1:1), the row is stamped
 *     `inrRate=1` so it is fully consistent, never left at rate 0.
 *   - Non-INR rows: the row's (day, currency) stored FxRate, else the currency's
 *     most recent stored rate, else a live multi-source fetch (persisted on
 *     success). `inrSpend := round(spend × rate, 2)`.
 *   - If a currency has NO stored rate AND every live source is unreachable →
 *     the affected rows are left untouched and the result is BLOCKED with the
 *     EXACT per-source error strings (never a fake rate).
 *   - Idempotent: a second run finds nothing to change (byte-identical).
 *   - NEVER deletes rows (upsert/update only).
 *
 * The diagnostic finding that shapes the honest report (2026-11-05, dev.db):
 * all 3,212 `inrSpend=0` rows are also `spend=0` (Meta's zero-spend
 * placeholder rows — `0 × rate = 0` is CORRECT), `moneyGap = 0`, and the
 * AED positive-spend rows are already normalised at the stored 25.849976
 * rate. So a run over today's data updates 0 rows in VALUE — that is the
 * expected, proven-correct outcome, not a failure.
 */
export interface InrZeroBackfillResult {
  scanned: number; // inrSpend=0 rows examined
  consistent: number; // already inrSpend == round(spend × rate, 2) + rate stamped
  rateStamped: number; // zero-spend rows that had inrRate=0, now stamped (value unchanged)
  recovered: number; // rows where a real value was recovered (inrSpend 0 → spend × rate)
  updates: number; // total rows written this run
  blocked: { currency: string; day: string; errors: string[] }[]; // no rate + all sources down
  totalInrBefore: number;
  totalInrAfter: number;
  zeroRowsBefore: number;
  zeroRowsAfter: number;
}

export async function backfillInrZeroRows(prisma: PrismaClient): Promise<InrZeroBackfillResult> {
  const totalInrBefore = (await prisma.spend.aggregate({ _sum: { inrSpend: true } }))._sum.inrSpend ?? 0;
  const zeroRowsBefore = await prisma.spend.count({ where: { inrSpend: 0 } });
  const zeros = await prisma.spend.findMany({
    where: { inrSpend: 0 },
    select: { id: true, currency: true, day: true, spend: true, inrRate: true, inrSpend: true },
  });

  const out: InrZeroBackfillResult = {
    scanned: zeros.length,
    consistent: 0,
    rateStamped: 0,
    recovered: 0,
    updates: 0,
    blocked: [],
    totalInrBefore: Math.round(totalInrBefore * 100) / 100,
    totalInrAfter: totalInrBefore,
    zeroRowsBefore,
    zeroRowsAfter: zeroRowsBefore,
  };

  // Resolve one rate per (currency, day) group; a second run reuses stored rows.
  type ZeroRow = (typeof zeros)[number];
  const groups = new Map<string, ZeroRow[]>();
  for (const r of zeros) {
    const key = `${r.currency}|${r.day}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  for (const [, rows] of groups) {
    const cur = rows[0].currency.toUpperCase();
    const day = rows[0].day;
    let rate: number;
    let liveErrors: string[] = [];
    if (cur === "INR") {
      rate = 1; // identity (spec 5.7: INR accounts convert 1:1, never fetched)
    } else {
      const stored = await prisma.fxRate.findUnique({
        where: { date_currency: { date: day, currency: cur } },
      });
      if (stored) {
        rate = stored.rateToInr; // per-day stored rate for THIS row's day (ticket rule 1)
      } else {
        // No per-day rate: live multi-source fetch, else most-recent stored
        // (the ticket's "stored FxRate 25.849976" path), else 0 = BLOCKED.
        const live = await fetchLiveFxRate(cur);
        if (live.rate > 0) {
          await prisma.fxRate.upsert({
            where: { date_currency: { date: day, currency: cur } },
            update: {},
            create: { date: day, currency: cur, rateToInr: live.rate, source: live.source ?? "unknown" },
          });
          rate = live.rate;
        } else {
          const fallback = await prisma.fxRate.findFirst({ where: { currency: cur }, orderBy: { date: "desc" } });
          rate = fallback?.rateToInr ?? 0;
          liveErrors = live.errors; // exact per-source strings (surfaced, not faked)
        }
      }
    }
    if (rate <= 0) {
      // BLOCKED: no stored rate and every FX source unreachable — leave the
      // rows untouched and record the EXACT error strings (ticket guardrail).
      out.blocked.push({ currency: cur, day, errors: liveErrors });
      continue;
    }
    for (const r of rows) {
      const target = Math.round(r.spend * rate * 100) / 100;
      const needsWrite = r.inrSpend !== target || (r.inrRate === 0 && target === 0);
      if (!needsWrite) {
        out.consistent++;
        continue;
      }
      await prisma.spend.update({
        where: { id: r.id },
        data: { inrRate: rate, inrSpend: target },
      });
      out.updates++;
      if (r.spend > 0) out.recovered++;
      else out.rateStamped++;
    }
  }

  const totalInrAfter = (await prisma.spend.aggregate({ _sum: { inrSpend: true } }))._sum.inrSpend ?? 0;
  const zeroRowsAfter = await prisma.spend.count({
    where: { inrSpend: 0, inrRate: 0 },
  });
  out.totalInrAfter = Math.round(totalInrAfter * 100) / 100;
  out.zeroRowsAfter = zeroRowsAfter;
  return out;
}

/**
 * Backfill `inrSpend` for stored NATIVE-ONLY spend rows (spec 5.7 / §4):
 * rows whose currency is not INR, `inrRate = 0` and `spend > 0` — i.e. pulled
 * when no FX rate was available. For each affected (currency, day) it
 * re-runs the stored-first `ensureRate` (which live-fetches + persists if
 * still missing) and, when a real rate is now available, re-computes
 * `inrSpend = round(spend * rate, 2)` on those rows.
 *
 * Idempotent: after a successful run no matching rows remain (inrRate is set),
 * so a second run finds nothing to update. When a currency is still unfetchable
 * (rate 0) its rows are left native-only — we never write a fake rate.
 */
export async function backfillMissingInr(prisma: PrismaClient): Promise<BackfillResult> {
  const out: BackfillResult = { currencies: [], days: [], updatedRows: 0, rates: [] };

  // The native-only rows: non-INR, inrRate=0, positive native spend.
  const affected = await prisma.spend.findMany({
    where: { inrRate: 0, spend: { gt: 0 } },
    select: { currency: true, day: true },
    distinct: ["currency", "day"],
  });
  if (affected.length === 0) return out;

  const byCurrencyDay = new Map<string, string>();
  for (const a of affected) byCurrencyDay.set(`${a.currency}|${a.day}`, a.currency);
  out.currencies = [...new Set([...byCurrencyDay.values()])];

  // Resolve one rate per (currency, day) — stored-first, live-fill on miss.
  for (const key of byCurrencyDay.keys()) {
    const [currency, day] = key.split("|");
    const r = await ensureRate(prisma, currency, day);
    out.days.push(`${currency}|${day}`);
    if (r.rate > 0) out.rates.push({ currency, day, rate: r.rate, source: null });
  }

  // Re-convert each affected (currency, day) row-by-row with its stored rate.
  // Idempotent: the predicate (inrRate=0 & spend>0) means once converted there
  // are no matching rows, so a second run is a no-op. When the rate is still 0
  // (currency unfetchable) we skip — never write a fake rate.
  let updated = 0;
  for (const key of byCurrencyDay.keys()) {
    const [currency, day] = key.split("|");
    const row = await prisma.fxRate.findUnique({
      where: { date_currency: { date: day, currency } },
    });
    const rate = row?.rateToInr ?? 0;
    if (rate <= 0) continue;
    const pending = await prisma.spend.findMany({
      where: { currency, day, inrRate: 0, spend: { gt: 0 } },
      select: { id: true, spend: true },
    });
    for (const p of pending) {
      await prisma.spend.update({
        where: { id: p.id },
        data: { inrRate: rate, inrSpend: Math.round((p.spend ?? 0) * rate * 100) / 100 },
      });
      updated++;
    }
  }
  out.updatedRows = updated;
  return out;
}
