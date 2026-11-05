/**
 * D-10 — on-demand Meta insights RANGE fetch (yesterday / 7d) with a
 * per-account, per-day cache (the ticket's "filter apply = API hit" that is
 * SERVER-ONLY: the dashboard server component calls this, never a browser
 * fetch; "same day + range = reuse, no repeated Meta hits").
 *
 * D-10 re-probe findings that shape this (committed matrix: DECISIONS D-10;
 * raw redacted findings: .d10-range-probe.txt, gitignored):
 *   - `time_range` (well-formed JSON) IS honored: 1d → 6,624; 7d → 34,379.17
 *     (distinct from the 30d 82,116.98 rollup).
 *   - 365d/730d CLAMP to the 30d value → only yesterday/7d are servable
 *     on-demand; last_month/last_year keep the stored-rollup label (never
 *     a faked year of data).
 *   - `period=day` is IGNORED (rows=1 even with a 7d range) → Meta serves a
 *     single RANGE ROLLUP, not per-day rows. The cache therefore stores the
 *     servable shape (one rollup per (adAccount, rangeKey, day)) — additive
 *     rows in the LiveRange table; the Spend fixed point is NEVER written to
 *     here (no deletes, no per-day Spend rows that Meta can't provide).
 *   - Malformed/empty time_range = 400 exact strings ("must be non-empty",
 *     "since must be <= until") — recorded as BLOCKED notes, never faked.
 *
 * Honesty rules (D-05/D-08): a Meta 4xx → `blockedNote` = the EXACT Meta
 * error string, value fields stay 0 (the UI shows a BLOCKED note, never an
 * empty grid, never a fabricated number). `fetchedAt` drives the UI's
 * "live, HH:MM IST" label (fresh <1h = "live"; older same-day = "cached").
 */
import { PrismaClient } from "../prisma";
import { resolveDayRates } from "../fx-store";

export type LiveRangeKey = "yesterday" | "7d";

/** The window Meta is asked for (UTC days). yesterday = a single day; 7d is
 *  the probe's honored 7-day window. Meta returns a rollup over its window. */
function windowFor(rangeKey: LiveRangeKey, nowMs: number): { since: string; until: string } {
  const day = (offMs: number) => new Date(nowMs - offMs).toISOString().slice(0, 10);
  const DAY = 86_400_000;
  return rangeKey === "yesterday"
    ? { since: day(DAY), until: day(DAY) } // [yesterday, yesterday]
    : { since: day(7 * DAY), until: day(DAY) }; // [7d ago, yesterday]
}

export interface LiveRangeResult {
  adAccountId: string;
  adAccountMetaId: string;
  accountName: string;
  rangeKey: LiveRangeKey;
  /** true when a cached row was reused this call (no Meta hit this call). */
  cached: boolean;
  /** Meta HTTP 200 and a value was (re)stored. */
  ok: boolean;
  /** the EXACT Meta 4xx error string when Meta refused; null when ok. */
  blockedNote: string | null;
  /** true when Meta returned a NARROWER window than requested (the probe's
   *  365/730d clamping) — the UI says "Meta served X, not Y", never fakes. */
  clamped: boolean;
  dateStart: string | null;
  dateStop: string | null;
  spendNative: number; // account billing currency
  spendInr: number; // INR-normalised via the stored daily FX rate
  currency: string;
  fetchedAt: string | null; // ISO; drives "live, HH:MM IST"
  /** fresh < 1h (the UI's "live" vs "cached" distinction). */
  fresh: boolean;
}

interface LiveRangeDeps {
  token?: string; // defaults to process.env.META_ACCESS_TOKEN
  apiVersion?: string; // defaults v23.0
  fetch?: typeof fetch; // injectable for tests
  nowMs?: number;
}

/**
 * Resolve ONE ad account's on-demand live range (yesterday | 7d).
 * Cache-first: a LiveRange row for (adAccountId, rangeKey, today-UTC) is
 * REUSED (no Meta call) — the "same day + range = reuse" rule. On a cache
 * miss, one Meta call; a 4xx is stored as a BLOCKED row (exact string,
 * zero values) so a re-hit shows the note, not an empty grid.
 *
 * No token → `ok:false` + blockedNote "no META_ACCESS_TOKEN…" (honest skip,
 * never a fabricated value). This is a READ + cache-upsert only: it never
 * touches the Spend table or any pull row.
 */
export async function resolveLiveRange(
  prisma: PrismaClient,
  adAccountId: string, // internal AdAccount id (not the Meta metaId)
  rangeKey: LiveRangeKey,
  deps: LiveRangeDeps = {},
): Promise<LiveRangeResult> {
  const { token = process.env.META_ACCESS_TOKEN ?? "", apiVersion = "v23.0", fetch: doFetch = fetch, nowMs = Date.now() } = deps;
  const acct = await prisma.adAccount.findUnique({ where: { id: adAccountId } });
  const base: LiveRangeResult = {
    adAccountId,
    adAccountMetaId: acct?.metaId ?? adAccountId,
    accountName: acct?.name ?? adAccountId,
    rangeKey,
    cached: false,
    ok: false,
    blockedNote: null,
    clamped: false,
    dateStart: null,
    dateStop: null,
    spendNative: 0,
    spendInr: 0,
    currency: acct?.currency ?? "INR",
    fetchedAt: null,
    fresh: false,
  };

  const day = new Date(nowMs).toISOString().slice(0, 10);
  const cache = await prisma.liveRange.findUnique({
    where: { adAccountId_rangeKey_day: { adAccountId, rangeKey, day } },
  });

  // No token: an honest skip (the UI keeps the stored-rollup label).
  if (!token) {
    base.blockedNote = "BLOCKED: no META_ACCESS_TOKEN set — live range fetch skipped (stored rollup shown instead)";
    return base;
  }
  if (!acct) {
    base.blockedNote = `BLOCKED: unknown ad account id '${adAccountId}'`;
    return base;
  }

  // Cache HIT: same day + range = reuse, no repeated Meta hit (idempotent).
  if (cache) {
    const isBlocked = Boolean(cache.blockedNote);
    base.cached = true;
    base.fetchedAt = cache.fetchedAt.toISOString();
    base.fresh = nowMs - cache.fetchedAt.getTime() < 3_600_000;
    base.dateStart = cache.dateStart;
    base.dateStop = cache.dateStop;
    base.currency = base.currency; // billing currency (shown on the UI)
    if (isBlocked) {
      base.blockedNote = cache.blockedNote ?? base.blockedNote;
      base.spendNative = 0;
      base.spendInr = 0;
      base.ok = false;
    } else {
      base.spendNative = cache.spend;
      base.spendInr = cache.spendInr;
      base.ok = true;
    }
    return base;
  }

  // Cache MISS: one Meta call for the account-level range rollup.
  const { since, until } = windowFor(rangeKey, nowMs);
  const tr = encodeURIComponent(JSON.stringify({ since, until }));
  const url = `https://graph.facebook.com/${apiVersion}/${acct.metaId}/insights?fields=date_start,date_stop,spend&time_range=${tr}&limit=10&access_token=${token}`;
  let http = 0;
  let bodyText = "";
  let meta: { date_start?: string; date_stop?: string; spend?: string; impressions?: string } | null = null;
  try {
    const res = await doFetch(url);
    http = res.status;
    bodyText = await res.text().catch(() => "");
    if (res.ok) {
      const j: any = JSON.parse(bodyText);
      meta = j?.data?.[0] ?? null;
    }
  } catch (e) {
    bodyText = `FETCH_ERROR ${String((e as { message?: unknown })?.message ?? e)}`;
  }

  // INR-normalise with the STORED daily FX rate for the window's stop day
  // (spec 5.7: reports never re-convert at report time). INR = identity.
  const currency = (acct.currency || "INR").toUpperCase();
  const { byDay } = await resolveDayRates(prisma, currency, [meta?.date_stop ?? day]);
  const rate = byDay.get(meta?.date_stop ?? day) ?? (currency === "INR" ? 1 : 0);

  if (http >= 200 && http < 300 && meta) {
    const spendNative = Number(meta.spend ?? 0) || 0;
    const spendInr = rate > 0 ? Math.round(spendNative * rate * 100) / 100 : 0;
    // Meta's insights arrive as strings; the LiveRange columns are Floats.
    const impressions = Number(meta.impressions ?? 0) || 0;
    // Clamp detection: Meta served a NARROWER window than requested (the
    // probe's 365/730d → 30d behaviour: Meta's date_start is LATER than the
    // requested since). Only yesterday/7d are requested today (both come
    // back at full width → clamped=false), but the flag stays honest if a
    // future rangeKey extends past Meta's served window.
    const requestedSince = windowFor(rangeKey, nowMs).since;
    const clamped = Boolean(meta.date_start && meta.date_start > requestedSince);
    await prisma.liveRange.upsert({
      where: { adAccountId_rangeKey_day: { adAccountId, rangeKey, day } },
      update: {
        dateStart: meta.date_start ?? day,
        dateStop: meta.date_stop ?? day,
        spend: spendNative,
        spendInr,
        impressions,
        reach: 0,
        clicks: 0,
        blockedNote: null,
      },
      create: {
        adAccountId,
        rangeKey,
        day,
        dateStart: meta.date_start ?? day,
        dateStop: meta.date_stop ?? day,
        spend: spendNative,
        spendInr,
        impressions,
        reach: 0,
        clicks: 0,
        blockedNote: null,
      },
    });
    return {
      ...base,
      ok: true,
      cached: false,
      fresh: true,
      clamped,
      dateStart: meta.date_start ?? day,
      dateStop: meta.date_stop ?? day,
      spendNative,
      spendInr,
      currency,
      fetchedAt: new Date(nowMs).toISOString(),
    };
  }

  // 4xx (or no payload): store the EXACT Meta error string as the BLOCKED
  // note (the UI shows it, never an empty grid / fake zero).
  let errMsg: string;
  try {
    const j = JSON.parse(bodyText);
    errMsg = `Meta HTTP ${http}: ${j?.error?.message ?? bodyText.slice(0, 160)}${j?.error?.error_subcode ? ` (subcode ${j.error.error_subcode})` : ""}`.slice(0, 400);
  } catch {
    errMsg = `Meta HTTP ${http || "ERR"}: ${bodyText.slice(0, 300)}`;
  }
  const note = errMsg;
  await prisma.liveRange.upsert({
    where: { adAccountId_rangeKey_day: { adAccountId, rangeKey, day } },
    update: { blockedNote: note, dateStart: since, dateStop: until, spend: 0, spendInr: 0, impressions: 0, reach: 0, clicks: 0 },
    create: {
      adAccountId, rangeKey, day, dateStart: since, dateStop: until,
      spend: 0, spendInr: 0, impressions: 0, reach: 0, clicks: 0, blockedNote: note,
    },
  });
  return { ...base, ok: false, blockedNote: note, dateStart: since, dateStop: until };
}

/**
 * Resolve the live range for EVERY ad account of a client set (the dashboard
 * call site). Per-account, per-day cached; capped so a giant set can't fan
 * out into hundreds of Meta calls in one render. Blocked accounts carry the
 * exact Meta string; the UI never blanks them.
 */
export async function resolveLiveRangesForAccounts(
  prisma: PrismaClient,
  adAccountIds: string[],
  rangeKey: LiveRangeKey,
  deps: LiveRangeDeps = {},
): Promise<LiveRangeResult[]> {
  const capped = adAccountIds.slice(0, 12);
  const out: LiveRangeResult[] = [];
  for (const id of capped) {
    out.push(await resolveLiveRange(prisma, id, rangeKey, deps));
  }
  return out;
}
