/**
 * Dashboard KPIs (screen 1). Aggregates the funnel + a spend-by-day series +
 * source mix for a client so the dashboard shows real numbers off the seeded
 * DB. Everything scopes by `clientId` (spec 10 RLS at the query layer).
 */
import { PrismaClient } from "./prisma";
import { funnelReport, sourceMix, adPerformance } from "./reports";
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
      select: { metaId: true, name: true, currency: true, status: true, id: true },
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
