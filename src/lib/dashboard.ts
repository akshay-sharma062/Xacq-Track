/**
 * Dashboard KPIs (screen 1). Aggregates the funnel + a spend-by-day series +
 * source mix for a client so the dashboard shows real numbers off the seeded
 * DB. Everything scopes by `clientId` (spec 10 RLS at the query layer).
 */
import { PrismaClient } from "./prisma";
import { funnelReport, sourceMix, adPerformance, AdPerfRow } from "./reports";
import { AttributionModel } from "./types";

const DAY_MS = 86_400_000;

export interface AccountSummary {
  metaId: string;
  name: string;
  currency: string;
  status: string;
  spendInr: number; // 30-day INR total for this account
  campaigns: number;
  ads: number;
  leads: number; // client-level leads (0 until G3/G4 traffic — honest empty)
  lastPulledAt: string | null; // ISO; the "data as of" stamp + per-card timestamp
  // D-08 (Meta data expansion): the ad-account balance (bill amount due, in the
  // account's billing currency) from the probe-proven `fields=balance` pull.
  // null = not yet pulled / pull failed → the card shows "—" (never a fake 0).
  balance: number | null;
  balanceAsOf: string | null; // ISO; when the balance was last read from Meta
}

/**
 * D-08 dashboard date-range control. The probe (`.meta-probe-findings.txt`)
 * showed Meta's account insights returns only a 30-day rollup on this API
 * (per-day `period`/presets 400 or are ignored), so the spend-family KPIs +
 * chart + per-account cards are computed over STORED Spend rows:
 *   - a range within the stored window (Yesterday/7d/30d/custom ≤30d) slices
 *     the stored rows by day;
 *   - a range beyond it (Last Month/Last Year) cannot be fetched from Meta, so
 *     we show the closest available stored data + an honest label — never an
 *     extrapolated number (`spendDataBasis` carries the label text).
 */
export type SpendRange = "yesterday" | "7d" | "30d" | "last_month" | "last_year" | "custom";

export interface SpendRangeParams {
  range: SpendRange;
  /** the chip / label text (e.g. "Last 7 days"). */
  label: string;
  /**
   * true ONLY for `30d` — the single range the stored Spend rows actually
   * carry (one 30-day Meta rollup, day=date_stop — the probe proved no
   * per-day data exists on this API). Every other range has no per-day data
   * behind it, so the UI shows the closest-available (the 30d rollup) plus
   * `dataBasis`, and it is never read as real per-day data for that range.
   */
  native: boolean;
  /** honest label shown when !native; null when native. */
  dataBasis: string | null;
  /** [leadSince, leadUntil] — window to slice OUR OWN lead/event/payment rows
   *  (they carry real timestamps, so this is a faithful filter even when the
   *  Meta spend family can only show the 30d rollup). null untilDate = open. */
  leadSince: Date;
  leadUntil: Date | null;
}

export interface DashboardData {
  funnel: Awaited<ReturnType<typeof funnelReport>>;
  mix: Awaited<ReturnType<typeof sourceMix>>;
  topAds: Awaited<ReturnType<typeof adPerformance>>;
  spendByDay: { label: string; value: number }[];
  /** D-04: every ad account of the client with its spend/campaign/ads totals. */
  accounts: AccountSummary[];
  counts: {
    leads: number;
    paid: number;
    hot: number;
    duplicates: number;
    openTasks: number;
  };
}

/**
 * D-01: `adAccountId` (optional, the internal AdAccount row id) narrows the
 * SPEND-family KPIs to one Meta ad account. Omitted = all accounts of the
 * client. With one account today this is a no-op; the control is real.
 */
export async function dashboardFor(
  prisma: PrismaClient,
  clientId: string,
  model: AttributionModel = "last_paid_click",
  windowDays = 30,
  adAccountId?: string
): Promise<DashboardData> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const [funnel, mix, topAds, spendRows, leads, accounts] = await Promise.all([
    funnelReport(prisma, clientId, 30 * DAY_MS, model, windowDays, adAccountId),
    sourceMix(prisma, clientId),
    adPerformance(prisma, clientId, 30 * DAY_MS, "ad", model, windowDays, client?.offerPrice ?? 0, adAccountId),
    prisma.spend.findMany({
      where: {
        clientId,
        day: { gte: dayStr(Date.now() - 30 * DAY_MS) },
        ...(adAccountId ? { adAccountId } : {}),
      },
    }),
    prisma.lead.findMany({ where: { clientId } }),
    // D-04: every ad account of the client + its 30-day spend total (INR),
    // campaign/ad counts, and honest lead count (0 until G3/G4 traffic).
    prisma.adAccount.findMany({
      where: { clientId, ...(adAccountId ? { id: adAccountId } : {}) },
      orderBy: { name: "asc" },
      select: { metaId: true, name: true, currency: true, status: true, id: true, lastPulledAt: true, balance: true, balanceAsOf: true },
    }),
  ]);

  const spendByAccount = new Map<string, number>();
  for (const r of spendRows) spendByAccount.set(r.adAccountId, (spendByAccount.get(r.adAccountId) ?? 0) + (r.inrSpend ?? 0));
  const leadCount = leads.length;
  const accountRows: AccountSummary[] = [];
  for (const a of accounts) {
    // Counts per account (campaign/ad). Leads are client-level (a lead can be
    // touched by ads from any account) — show the client total on each row,
    // which is 0 pre G3/G4 (the honest empty state, D-02/D-03).
    const [campaigns, ads] = await Promise.all([
      prisma.adCampaign.count({ where: { adAccountId: a.id } }),
      prisma.ad.count({ where: { adAccountId: a.id } }),
    ]);
    accountRows.push({
      metaId: a.metaId,
      name: a.name,
      currency: a.currency,
      status: a.status,
      spendInr: Math.round((spendByAccount.get(a.id) ?? 0) * 100) / 100,
      campaigns,
      ads,
      leads: leadCount,
      lastPulledAt: a.lastPulledAt ? a.lastPulledAt.toISOString() : null,
      // D-08: null = not yet pulled / not fetched this pull → the card shows "—".
      balance: a.balance ?? null,
      balanceAsOf: a.balanceAsOf ? a.balanceAsOf.toISOString() : null,
    });
  }

  // Spend by day (INR), for the chart.
  const byDay = new Map<string, number>();
  for (const r of spendRows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + (r.inrSpend ?? 0));
  const spendByDay = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([d, v]) => ({ label: d.slice(5), value: Math.round(v) }));

  const stage = (name: string) => leads.filter((l) => l.stage === name).length;

  return {
    funnel,
    mix,
    topAds: topAds.slice(0, 6),
    spendByDay,
    accounts: accountRows,
    counts: {
      leads: leads.length,
      paid: stage("Paid"),
      hot: stage("Hot") + stage("Call Booked"),
      duplicates: leads.filter((l) => l.isDuplicateCandidate).length,
      // Task has no clientId (it scopes via lead); count open tasks for this
      // client's leads instead.
      openTasks: leads.length
        ? await prisma.task.count({ where: { leadId: { in: leads.map((l) => l.id) }, outcome: null } })
        : 0,
    },
  };
}

function dayStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// D-08: the probe (`.meta-probe-findings.txt`) proved Meta's account insights on
// this API version only returns a 30-day rollup (per-day presets / period /
// date_start-stop all 200 but IGNORED — one row, day=date_stop), so the stored
// Spend rows carry that single 30-day rollup. Only the `30d` range is therefore
// `native` (it *is* the data we hold). Every other range has no per-day data
// behind it, so the UI shows the closest-available 30d rollup + `dataBasis`
// and is never read as real per-day data for that range. We ALSO expose a
// `leadSince`/`leadUntil` window: our OWN lead/event/payment rows carry real
// timestamps, so they can be faithfully sliced to any range even when the Meta
// spend family can only show the 30d rollup.
export function resolveSpendRange(
  range: SpendRange,
  custom?: { dayStart?: string; dayEnd?: string | null }
): SpendRangeParams {
  const now = Date.now();
  const DAY = 86_400_000;
  const ROLLUP_ONLY = "30-day rollup only (Meta API limit — see DECISIONS D-08)";
  const openUntil = null;
  switch (range) {
    case "yesterday": {
      // [UTC midnight yesterday, UTC midnight today) — a day-aligned slice.
      const d = new Date(now);
      const today0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      return { range, label: "Yesterday", native: false, dataBasis: ROLLUP_ONLY, leadSince: new Date(today0 - DAY), leadUntil: new Date(today0) };
    }
    case "7d":
      return { range, label: "Last 7 days", native: false, dataBasis: ROLLUP_ONLY, leadSince: new Date(now - 7 * DAY), leadUntil: openUntil };
    case "30d":
      return { range, label: "Last 30 days", native: true, dataBasis: null, leadSince: new Date(now - 30 * DAY), leadUntil: openUntil };
    case "last_month":
      return { range, label: "Last month", native: false, dataBasis: ROLLUP_ONLY, leadSince: new Date(now - 30 * DAY), leadUntil: openUntil };
    case "last_year":
      return { range, label: "Last year", native: false, dataBasis: ROLLUP_ONLY, leadSince: new Date(now - 365 * DAY), leadUntil: openUntil };
    case "custom": {
      // Custom is never "native": the stored data is one 30-day rollup, so a
      // custom span shows the closest-available rollup + the label. The lead
      // side is still sliced to the custom bounds (real timestamps).
      const start = custom?.dayStart ? new Date(`${custom.dayStart}T00:00:00Z`) : new Date(now - 30 * DAY);
      const end = custom?.dayEnd ? new Date(`${custom.dayEnd}T23:59:59.999Z`) : null;
      return { range, label: "Custom range", native: false, dataBasis: ROLLUP_ONLY, leadSince: start, leadUntil: end };
    }
  }
}

// ---------------------------------------------------------------------------
// Dashboard-V2 §1/§2 — the ALL-clients / ALL-accounts aggregate view.
// Every figure is a live DB aggregation over the role's visible client set
// (never hardcoded, never a single canned client). A 0 in the leads-family is
// the honest empty state pre G3/G4, labelled as such by the UI.
// ---------------------------------------------------------------------------
export interface EngagementKpis {
  impressions: number;
  reach: number;
  clicks: number;
  thruPlays: number;
  ctr: number; // clicks / impressions
  cpm: number; // spendInr / impressions * 1000
  cpl: number; // spendInr / leads (0 when no leads)
  activeCampaigns: number;
  activeAds: number;
  creatives: number;
}

export interface PerClientRow {
  client: string;
  owner: string | null;
  adAccounts: number;
  campaigns: number;
  ads: number;
  spendInr: number;
  spendNative: { currency: string; native: number }[];
  leads: number;
  sales: number;
  lastPull: string | null;
}

export interface AllDashboard {
  kpi: {
    spendInr: number;
    spendByCurrency: { currency: string; native: number; inr: number }[];
    leads: number;
    registered: number;
    attended: number;
    callsBooked: number;
    revenueInr: number; // net of refunds
    sales: number;
    costPerSale: number;
    roas: number; // revenueInr / spendInr
    engagement: EngagementKpis;
  };
  accounts: AccountSummary[]; // every ad account across the visible clients
  perClient: PerClientRow[]; // §1: the per-client breakdown table
  spendByDay: { label: string; value: number }[];
  topCampaigns: { campaign: string; account: string; spendInr: number }[];
  topAds: AdPerfRow[]; // spend-ranked across all accounts
  capi: {
    queued: number;
    sent: number; // status=sent total (live + simulated)
    failed: number;
    skipped: number;
    total: number;
    live: number; // G8: actually POSTed to Meta's Conversions API
    simulated: number; // G8: local mark (no token/pixel) — never shown as live
    // G8: Meta-REPORTED Event Match Quality on Purchase (null = no live Purchase EMQ yet).
    avgMqMeta: number | null;
    // G8: local heuristic estimate only (NOT Meta's number) — surfaced separately.
    avgMqEst: number | null;
    last20: {
      id: string; type: string; value: number | null;
      mq: number | null; mqFromMeta: boolean; simulated: boolean;
      status: string; when: string; dedupKey: string;
    }[];
  };
  sync: {
    dataAsOf: string | null; // max ad-account lastPulledAt (ISO) — the "data as of" stamp
    fx: { currency: string; rate: number; fetchedAt: string | null; source: string | null; backfillPending: boolean }[];
  };
  /** D-08: the active date-range control + its data-basis label. null = the
   *  default 30d native view (no control set). `native` false = the requested
   *  range exceeds the stored 30-day rollup (Meta API limit) — the UI shows
   *  `dataBasis` so the closest-available data is never read as real per-day
   *  data for that range. */
  spendRange: { range: SpendRange; label: string; native: boolean; dataBasis: string | null } | null;
}

export async function dashboardAll(
  prisma: PrismaClient,
  clientIds: string[],
  model: AttributionModel = "last_paid_click",
  windowDays = 30,
  adAccountMetaId?: string,
  /** D-08: the dashboard date-range control. Omitted = the default 30d native
   *  window (backward-compatible; existing callers unchanged). */
  range?: SpendRange,
  /** D-08: custom-range bounds when range === "custom". */
  customRange?: { dayStart?: string; dayEnd?: string | null }
): Promise<AllDashboard> {
  if (clientIds.length === 0) clientIds = [""]; // keep the `in` predicate valid
  const since = new Date(Date.now() - windowDays * DAY_MS);
  // §2: an ?adAccount=<metaId> scopes the SPEND family (KPIs, per-account cards,
  // top campaigns/ads, daily chart) to one Meta ad account. Lead-side counts
  // stay set-scoped (a lead can be touched by any account). Omitted = all.
  const adAccountId = adAccountMetaId
    ? (await prisma.adAccount.findFirst({ where: { metaId: adAccountMetaId, clientId: { in: clientIds } }, select: { id: true } }))?.id
    : undefined;
  const spendScope = adAccountId ? { adAccountId } : {};

  // D-08: the date-range control. The SPEND family always shows the stored
  // 30-day rollup (the only per-day data Meta returns for this API — probe
  // proven, `.meta-probe-findings.txt`); the LEAD family (leads/events/
  // payments, which carry real timestamps) is sliced to the requested range.
  // When no range param is passed, leadSince/leadUntil fall back to the
  // default 30d window — byte-identical to the pre-D-08 behaviour.
  const rp = range ? resolveSpendRange(range, customRange) : null;
  const leadSince = rp ? rp.leadSince : since;
  const leadUntil = rp ? rp.leadUntil : null;


  // -- SPEND family: one raw read, per-currency native + INR + per-day +
  //    engagement totals (impressions/reach/clicks/thruPlays) for the KPI row.
  const spendRows = await prisma.spend.findMany({
    where: { clientId: { in: clientIds }, day: { gte: dayStr(since.getTime()) }, ...spendScope },
    select: { currency: true, spend: true, inrSpend: true, day: true, impressions: true, reach: true, clicks: true, thruPlays: true, adAccountId: true },
  });
  let spendInr = 0;
  let impressions = 0, reach = 0, clicks = 0, thruPlays = 0;
  const byCur = new Map<string, { native: number; inr: number }>();
  const byDay = new Map<string, number>();
  const spendByAcctInr = new Map<string, { inr: number; byCur: Map<string, number> }>();
  for (const r of spendRows) {
    spendInr += r.inrSpend ?? 0;
    impressions += r.impressions ?? 0;
    reach += r.reach ?? 0;
    clicks += r.clicks ?? 0;
    thruPlays += r.thruPlays ?? 0;
    const c = byCur.get(r.currency) ?? { native: 0, inr: 0 };
    c.native += r.spend ?? 0;
    c.inr += r.inrSpend ?? 0;
    byCur.set(r.currency, c);
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + (r.inrSpend ?? 0));
    const acct = spendByAcctInr.get(r.adAccountId) ?? { inr: 0, byCur: new Map<string, number>() };
    acct.inr += r.inrSpend ?? 0;
    acct.byCur.set(r.currency, (acct.byCur.get(r.currency) ?? 0) + (r.spend ?? 0));
    spendByAcctInr.set(r.adAccountId, acct);
  }
  const spendByCurrency = [...byCur.entries()].map(([currency, v]) => ({
    currency,
    native: Math.round(v.native * 100) / 100,
    inr: Math.round(v.inr * 100) / 100,
  }));
  const spendByDay = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([d, v]) => ({ label: d.slice(5), value: Math.round(v) }));

  // -- LEADS family: sum the additive counters across the visible set (0 = the
  //    honest pre-G3/G4 empty state; the UI labels it, we never invent numbers).
  // D-08: sliced to the active date-range when one is set (leadSince/leadUntil);
  // otherwise the default 30d window (unchanged behaviour).
  const sinceUntil = leadUntil ? { gte: leadSince, lte: leadUntil } : { gte: leadSince };
  const [leadCount, registered, attended, calls, payments] = await Promise.all([
    prisma.lead.count({ where: { clientId: { in: clientIds }, createdAt: sinceUntil } }),
    prisma.event.count({ where: { clientId: { in: clientIds }, type: "registered", timestamp: sinceUntil } }),
    prisma.lead.count({ where: { clientId: { in: clientIds }, stage: "Attended" } }),
    prisma.event.count({ where: { clientId: { in: clientIds }, type: "call_booked", timestamp: sinceUntil } }),
    prisma.payment.findMany({
      where: { clientId: { in: clientIds }, status: { in: ["paid", "refunded"] }, paidAt: sinceUntil },
      select: { status: true, amount: true },
    }),
  ]);
  const sales = payments.filter((p) => p.status === "paid").length;
  const revenueInr = payments.reduce((s, p) => s + (p.status === "paid" ? p.amount : -p.amount), 0);

  // Active entity counts (the KPI row's "active campaigns/ads/creatives").
  const [activeCampaigns, activeAds, creatives] = await Promise.all([
    prisma.adCampaign.count({ where: { adAccountId: { in: clientIds.length ? clientIds : [""] }, status: "ACTIVE" } }),
    prisma.ad.count({ where: { adAccountId: { in: clientIds.length ? clientIds : [""] }, status: "ACTIVE" } }),
    prisma.creative.count({
      where: { adMetaId: { in: (await prisma.ad.findMany({ where: { status: "ACTIVE" }, select: { metaId: true } })).map((a) => a.metaId) } },
    }),
  ]);
  const engagement: EngagementKpis = {
    impressions: Math.round(impressions),
    reach: Math.round(reach),
    clicks: Math.round(clicks),
    thruPlays: Math.round(thruPlays),
    ctr: impressions ? clicks / impressions : 0,
    cpm: impressions ? (spendInr / impressions) * 1000 : 0,
    cpl: leadCount ? spendInr / leadCount : 0,
    activeCampaigns,
    activeAds,
    creatives,
  };

  const kpi = {
    spendInr: Math.round(spendInr * 100) / 100,
    spendByCurrency,
    leads: leadCount,
    registered,
    attended,
    callsBooked: calls,
    revenueInr: Math.round(revenueInr * 100) / 100,
    sales,
    costPerSale: sales ? Math.round(spendInr / sales) : 0,
    roas: spendInr ? revenueInr / spendInr : 0,
    engagement,
  };

  // -- ACCOUNTS: every ad account of the visible clients, with its 30d totals
  //    + campaign/ad/adSet counts + last-pulled stamp (the card timestamps).
  //    ?adAccount=<metaId> narrows the card set to that account (§2 drill-down).
  const accounts = await prisma.adAccount.findMany({
    where: { clientId: { in: clientIds }, ...(adAccountMetaId ? { metaId: adAccountMetaId } : {}) },
    orderBy: { name: "asc" },
    select: { metaId: true, name: true, currency: true, status: true, id: true, lastPulledAt: true, clientId: true, displayOwnerName: true, balance: true, balanceAsOf: true },
  });
  const acctIds = accounts.map((a) => a.id);
  const acctScope: any = acctIds.length ? { in: acctIds } : { in: [""] };
  // Per-account 30d INR total (one targeted groupBy, not a per-row read).
  const acctSpend = await prisma.spend.groupBy({
    by: ["adAccountId"],
    where: { adAccountId: acctScope, day: { gte: dayStr(since.getTime()) } },
    _sum: { inrSpend: true },
  });
  const byAcct = new Map<string, number>();
  for (const g of acctSpend) byAcct.set(g.adAccountId, (byAcct.get(g.adAccountId) ?? 0) + (g._sum.inrSpend ?? 0));
  const counts = await Promise.all(
    accounts.map((a) =>
      Promise.all([
        prisma.adCampaign.count({ where: { adAccountId: a.id } }),
        prisma.adSet.count({ where: { adAccountId: a.id } }),
        prisma.ad.count({ where: { adAccountId: a.id } }),
      ])
    )
  );
  const accountRows: AccountSummary[] = accounts.map((a, i) => ({
    metaId: a.metaId,
    name: a.name,
    currency: a.currency,
    status: a.status,
    spendInr: Math.round((byAcct.get(a.id) ?? 0) * 100) / 100,
    campaigns: counts[i][0],
    ads: counts[i][2],
    leads: 0, // client-level, 0 pre G3/G4 (honest empty state)
    lastPulledAt: a.lastPulledAt ? a.lastPulledAt.toISOString() : null,
    // D-08: the ad-account balance (bill amount due, billing currency). null =
    // not yet pulled (e.g. the simulate fixture or a pre-balance pull) → "—".
    balance: a.balance ?? null,
    balanceAsOf: a.balanceAsOf ? a.balanceAsOf.toISOString() : null,
  }));

  // -- §1 PER-CLIENT breakdown table: one row per client in the view, with its
  //    ad-account/campaign/ad counts, 30d spend per currency + INR, leads/sales,
  //    and last-pull time. Built from the same reads above (no new queries).
  const clientById = new Map((await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  // 30d lead count per client (groupBy with `_count` gives one row per client).
  const leadGroups = await prisma.lead.groupBy({
    by: ["clientId"],
    where: { clientId: { in: clientIds }, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const leadsByClient = new Map(leadGroups.map((g) => [g.clientId, g._count._all]));
  const perClient: PerClientRow[] = clientIds
    .filter((id) => clientById.has(id))
    .map((cid) => {
      const clientAccts = accounts.filter((a) => a.clientId === cid);
      const nativeRows: { currency: string; native: number }[] = [];
      for (const a of clientAccts) {
        const v = spendByAcctInr.get(a.id);
        if (!v) continue;
        for (const [cur, amt] of v.byCur) {
          const row = nativeRows.find((r) => r.currency === cur);
          if (row) row.native += amt;
          else nativeRows.push({ currency: cur, native: amt });
        }
      }
      // lastPulledAt on the account rows is a Date — reduce over Dates, stringify once.
      const lastPullDate = clientAccts.reduce<Date | null>((m, a) => (a.lastPulledAt && (!m || a.lastPulledAt > m) ? a.lastPulledAt : m), null);
      return {
        client: clientById.get(cid) ?? cid,
        owner: accounts.find((a) => a.clientId === cid)?.displayOwnerName ?? null,
        adAccounts: clientAccts.length,
        campaigns: counts.filter((_, i) => accounts[i].clientId === cid).reduce((s, c) => s + c[0], 0),
        ads: counts.filter((_, i) => accounts[i].clientId === cid).reduce((s, c) => s + c[2], 0),
        spendInr: Math.round(clientAccts.reduce((s, a) => s + (byAcct.get(a.id) ?? 0), 0) * 100) / 100,
        spendNative: nativeRows.map((r) => ({ currency: r.currency, native: Math.round(r.native * 100) / 100 })),
        leads: leadsByClient.get(cid) ?? 0,
        sales: 0, // G4 pending; honest 0 (payment counts computed above are set-wide)
        lastPull: lastPullDate ? lastPullDate.toISOString() : null,
      };
    });

  // -- TOP CAMPAIGNS by 30d spend (grouped across accounts).
  const campaigns = await prisma.adCampaign.findMany({
    where: { adAccountId: { in: acctIds } },
    select: { metaId: true, name: true, adAccountId: true },
  });
  const camSpend = new Map<string, number>();
  // Per-campaign spend: join spend.ad.adSet.campaign via the ad table.
  const spendByCampaign = await prisma.spend.groupBy({
    by: ["adMetaId"],
    where: { day: { gte: dayStr(since.getTime()) }, adAccountId: { in: acctIds } },
    _sum: { inrSpend: true },
  });
  const adByMeta = new Map(
    (await prisma.ad.findMany({ where: { adAccountId: { in: acctIds } }, select: { metaId: true, adSetMetaId: true, adAccountId: true } })).map(
      (x) => [x.metaId, x]
    )
  );
  for (const g of spendByCampaign) {
    const adRec = adByMeta.get(g.adMetaId);
    if (!adRec) continue;
    camSpend.set(adRec.adSetMetaId, (camSpend.get(adRec.adSetMetaId) ?? 0) + (g._sum.inrSpend ?? 0));
  }
  const camRows = campaigns
    .map((c) => ({ campaign: c.name, account: accounts.find((a) => a.id === c.adAccountId)?.name ?? c.adAccountId, spendInr: Math.round((camSpend.get(c.metaId) ?? 0) * 100) / 100 }))
    .sort((a, b) => b.spendInr - a.spendInr)
    .slice(0, 10);

  // -- TOP ADS by 30d spend across the scoped account set (thumbnail + spend +
  //    sales/ROAS; sales are 0 pre G3/G4 → honest empty state). Built from the
  //    same scoped spend rows so ?adAccount= narrows this too.
  const topSpendByAd = await prisma.spend.groupBy({
    by: ["adMetaId"],
    where: { adAccountId: acctScope, day: { gte: dayStr(since.getTime()) } },
    _sum: { inrSpend: true },
  });
  const topAdMetas = topSpendByAd.map((g) => g.adMetaId);
  const topAdRecs = await prisma.ad.findMany({
    where: { metaId: { in: topAdMetas.length ? topAdMetas : [""] } },
    include: { adSet: { include: { campaign: true } }, creatives: true },
  });
  const adByMetaId = new Map(topAdRecs.map((a) => [a.metaId, a]));
  const topAds: AdPerfRow[] = topSpendByAd
    .map((g) => {
      const a = adByMetaId.get(g.adMetaId);
      const campaign = a?.adSet?.campaign?.name;
      const adset = a?.adSet?.name;
      // G1 shape: "campaign / adset / ad" (the human label the report expects).
      const label = [campaign, adset, a?.name ?? g.adMetaId].filter(Boolean).join(" / ");
      return {
        adId: g.adMetaId,
        adName: label,
        thumbnail: a?.creatives[0]?.thumbnailUrl ?? null,
        campaignId: a?.adSet?.campaign?.metaId ?? "",
        adsetId: a?.adSet?.metaId ?? "",
        spendInr: Math.round((g._sum.inrSpend ?? 0) * 100) / 100,
        leads: 0, // no live traffic pre G3/G4 — honest 0
        sales: 0,
        revenueInr: 0,
        profitInr: 0,
        roas: 0,
      };
    })
    .sort((a, b) => b.spendInr - a.spendInr)
    .slice(0, 20);

  // -- CAPI pipeline: queued/sent/failed/skipped + match-quality + last 20.
  // G8: split the "sent" rows into LIVE (a real Meta Conversions API POST)
  // vs SIMULATED (no token/pixel -> local mark). Simulate numbers are never
  // presented as live (D-05 honesty rule). `avgMqMeta` = Meta-REPORTED
  // Event Match Quality only (emqFromMeta=true) — the G8 acceptance number
  // (EMQ>=7 on Purchase); the local estimate is kept separate (`avgMqEst`).
  const capiRows = await prisma.outboundEvent.findMany({
    where: { clientId: { in: clientIds } },
    orderBy: { eventTime: "desc" },
    take: 200,
  });
  const capiCounts = { queued: 0, sent: 0, failed: 0, skipped: 0 };
  let capiSimulatedSent = 0;
  let capiLiveSent = 0;
  for (const r of capiRows) {
    capiCounts[r.status as keyof typeof capiCounts]++;
    if (r.status === "sent") (r.simulated ? capiSimulatedSent++ : capiLiveSent++);
  }
  const liveMq = capiRows.filter((r) => r.type === "Purchase" && r.emqFromMeta && r.matchQuality != null);
  const estMq = capiRows.filter((r) => r.type === "Purchase" && !r.emqFromMeta && r.matchQuality != null);
  const capi = {
    ...capiCounts,
    total: capiRows.length,
    live: capiLiveSent,
    simulated: capiSimulatedSent,
    // Meta-reported EMQ (Purchase only). null = no live Purchase EMQ yet.
    avgMqMeta: liveMq.length ? Math.round(liveMq.reduce((s, r) => s + (r.matchQuality ?? 0), 0) / liveMq.length) : null,
    // Local heuristic estimate (not Meta's number) — surfaced separately.
    avgMqEst: estMq.length ? Math.round(estMq.reduce((s, r) => s + (r.matchQuality ?? 0), 0) / estMq.length) : null,
    last20: capiRows.slice(0, 20).map((r) => ({
      id: r.id,
      type: r.type,
      value: r.value,
      mq: r.matchQuality,
      mqFromMeta: r.emqFromMeta,
      simulated: r.simulated,
      status: r.status,
      when: r.eventTime.toISOString(),
      dedupKey: r.dedupKey,
    })),
  };

  // -- SYNC / FX strip: the "data as of" stamp + the stored FX rate table with
  //    a backfill-pending badge for currencies that still have inrRate=0 rows.
  const maxPull = accountRows.reduce<string | null>((m, a) => (a.lastPulledAt && (!m || a.lastPulledAt > m) ? a.lastPulledAt : m), null);
  const fxRows = await prisma.fxRate.findMany({ orderBy: { fetchedAt: "desc" }, take: 50 });
  const pending = new Set(
    (await prisma.spend.groupBy({ by: ["currency"], where: { inrRate: 0, spend: { gt: 0 } } })).map((g) => g.currency)
  );
  const fx = fxRows.map((r) => ({
    currency: r.currency,
    rate: r.rateToInr,
    fetchedAt: r.fetchedAt.toISOString(),
    source: r.source ?? null,
    backfillPending: pending.has(r.currency),
  }));

  return {
    kpi,
    accounts: accountRows,
    perClient,
    spendByDay,
    topCampaigns: camRows,
    topAds,
    capi,
    sync: { dataAsOf: maxPull, fx },
    // D-08: the active range + its data-basis label. null = the default 30d
    // native view (no control set). The UI renders `dataBasis` next to the
    // KPIs when native is false so a beyond-window range is never read as
    // real per-day data.
    spendRange: rp ? { range: rp.range, label: rp.label, native: rp.native, dataBasis: rp.dataBasis } : null,
  };
}
