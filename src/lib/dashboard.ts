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
      select: { metaId: true, name: true, currency: true, status: true, id: true, lastPulledAt: true },
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
    sent: number;
    failed: number;
    skipped: number;
    total: number;
    avgMq: number | null;
    last20: { id: string; type: string; value: number | null; mq: number | null; status: string; when: string; dedupKey: string }[];
  };
  sync: {
    dataAsOf: string | null; // max ad-account lastPulledAt (ISO) — the "data as of" stamp
    fx: { currency: string; rate: number; fetchedAt: string | null; source: string | null; backfillPending: boolean }[];
  };
}

export async function dashboardAll(
  prisma: PrismaClient,
  clientIds: string[],
  model: AttributionModel = "last_paid_click",
  windowDays = 30,
  adAccountMetaId?: string
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
  const [leadCount, registered, attended, calls, payments] = await Promise.all([
    prisma.lead.count({ where: { clientId: { in: clientIds }, createdAt: { gte: since } } }),
    prisma.event.count({ where: { clientId: { in: clientIds }, type: "registered", timestamp: { gte: since } } }),
    prisma.lead.count({ where: { clientId: { in: clientIds }, stage: "Attended" } }),
    prisma.event.count({ where: { clientId: { in: clientIds }, type: "call_booked", timestamp: { gte: since } } }),
    prisma.payment.findMany({
      where: { clientId: { in: clientIds }, status: { in: ["paid", "refunded"] }, paidAt: { gte: since } },
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
    select: { metaId: true, name: true, currency: true, status: true, id: true, lastPulledAt: true, clientId: true, displayOwnerName: true },
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

  // -- CAPI pipeline: queued/sent/failed/skipped + avg match-quality + last 20.
  const capiRows = await prisma.outboundEvent.findMany({
    where: { clientId: { in: clientIds } },
    orderBy: { eventTime: "desc" },
    take: 200,
  });
  const capiCounts = { queued: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of capiRows) capiCounts[r.status as keyof typeof capiCounts]++;
  const mqRows = capiRows.filter((r) => r.matchQuality != null);
  const capi = {
    ...capiCounts,
    total: capiRows.length,
    avgMq: mqRows.length ? Math.round(mqRows.reduce((s, r) => s + (r.matchQuality ?? 0), 0) / mqRows.length) : null,
    last20: capiRows.slice(0, 20).map((r) => ({
      id: r.id,
      type: r.type,
      value: r.value,
      mq: r.matchQuality,
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
  };
}
