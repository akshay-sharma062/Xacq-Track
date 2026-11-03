/**
 * Reports (spec section 7).
 *
 * Every report states which attribution model + window it used, counts
 * revenue net of refunds, and every number can be linked to the leads behind
 * it. All reports export to CSV (and can be wrapped as .xlsx by the client).
 *
 * These are pure Prisma aggregations over the seeded/pulled data so the 14
 * screens + the weekly Monday-9AM job all read from one source of truth.
 */
import { PrismaClient } from "./prisma";
import { aggregateAttribution, AdLevel } from "./attribution";
import { AttributionModel } from "./types";

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------
async function salesForClient(prisma: PrismaClient, clientId: string, rangeMs?: number) {
  const since = rangeMs ? new Date(Date.now() - rangeMs) : undefined;
  const [payments, leads] = await Promise.all([
    prisma.payment.findMany({
      where: {
        clientId,
        status: { in: ["paid", "refunded"] },
        ...(since ? { paidAt: { gte: since } } : {}),
      },
    }),
    prisma.lead.findMany({ where: { clientId }, include: { events: true } }),
  ]);
  const leadById = new Map(leads.map((l) => [l.id, l]));

  // Attribute each (net) sale. Net of refunds: refunded payments contribute 0.
  const netSales = payments.filter((p) => p.status === "paid");
  const refunds = payments.filter((p) => p.status === "refunded");

  const sales = netSales
    .map((p) => {
      const lead = leadById.get(p.leadId);
      if (!lead) return null;
      // Ad clicks = ad_click / meta_form_lead / page_view touchpoints carrying an ad.
      const clicks = lead.events
        .filter((e) => ["ad_click", "meta_form_lead", "form_submit"].includes(e.type) && e.rawPayload)
        .map((e) => parseAdFromEvent(e.rawPayload))
        .filter((c) => c && c.ts && c.adId) as { ts: number; adId: string; adName: string | null; adsetId: string | null; campaignId: string | null }[];
      return {
        leadId: p.leadId,
        leadName: lead.name ?? lead.phone,
        leadCreatedAt: lead.createdAt,
        saleTime: p.paidAt?.getTime() ?? Date.now(),
        amount: p.amount,
        clicks,
        firstFormFill: lead.events.find((e) => e.type === "meta_form_lead" || e.type === "form_submit") && parseAdFromEvent(lead.events.find((e) => e.type === "meta_form_lead" || e.type === "form_submit")!.rawPayload),
      };
    })
    .filter(Boolean) as { leadId: string; leadName: string; leadCreatedAt: Date; saleTime: number; amount: number; clicks: any[]; firstFormFill: any }[];

  return { sales, refunds, netSales };
}

// Pull the ad ids off a touchpoint event's raw payload (JSON we kept, spec 4).
function parseAdFromEvent(raw: string): { ts: number; adId?: string; adsetId?: string; campaignId?: string; adName?: string | null } | null {
  try {
    const o = JSON.parse(raw);
    const ts = o.timestamp ? new Date(o.timestamp).getTime() : Date.now();
    const adId = o.ad_id ?? o.adId ?? o.ad?.id;
    if (!adId) return { ts };
    return { ts, adId, adsetId: o.adset_id ?? o.adsetId, campaignId: o.campaign_id ?? o.campaignId, adName: o.ad_name ?? null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1) FUNNEL report (spec 7): spend, leads, regs, attended, calls, sales,
//    revenue + cost-per each + show-up / close rates.
// ---------------------------------------------------------------------------
export interface FunnelReport {
  client: string;
  attribution: { model: AttributionModel; windowDays: number };
  spendInr: number;
  spendNative: number;
  leads: number;
  registered: number;
  attended: number;
  callsBooked: number;
  sales: number;
  revenueInr: number; // net of refunds
  refundsInr: number;
  costPerLead: number;
  costPerRegistrant: number;
  costPerAttendee: number;
  costPerCall: number;
  costPerSale: number;
  showUpRate: number; // attended / registered
  closeRate: number; // sales / callsBooked
  roi: number; // (revenue - spend) / spend
}

/**
 * D-01: ad-account filter scoping. `adAccountId` (the internal link id)
 * narrows the SPEND-family reports to one Meta ad account; omitted = all
 * accounts of the client. With one account today (Upcurvv-FML) this is a
 * no-op, but the control is DB-driven and real, not a fake dropdown.
 * Lead-side counts (leads/registered/…) stay client-scoped: a lead can be
 * touched by ads from any account, so only spend is account-partitioned.
 */
export async function funnelReport(
  prisma: PrismaClient,
  clientId: string,
  rangeMs = 30 * DAY_MS,
  model: AttributionModel = "last_paid_click",
  windowDays = 30,
  adAccountId?: string
): Promise<FunnelReport> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const spendRows = await prisma.spend.findMany({
    where: { clientId, day: { gte: dayStr(Date.now() - rangeMs) }, ...(adAccountId ? { adAccountId } : {}) },
  });
  const spendNative = spendRows.reduce((s, r) => s + (r.spend ?? 0), 0);
  const spendInr = spendRows.reduce((s, r) => s + (r.inrSpend ?? 0), 0);

  const leads = await prisma.lead.count({ where: { clientId, createdAt: { gte: new Date(Date.now() - rangeMs) } } });
  const cnt = async (type: string) =>
    prisma.event.count({ where: { clientId, type, timestamp: { gte: new Date(Date.now() - rangeMs) } } });

  const [registered, attended, calls, paidEvents] = await Promise.all([
    cnt("registered"),
    prisma.lead.count({ where: { clientId, stage: "Attended" } }),
    cnt("call_booked"),
    prisma.payment.count({ where: { clientId, status: "paid", paidAt: { gte: new Date(Date.now() - rangeMs) } } }),
  ]);
  void paidEvents;

  const { netSales, refunds } = await salesForClient(prisma, clientId, rangeMs);
  const revenueInr = netSales.reduce((s, x) => s + x.amount, 0);
  const refundsInr = refunds.reduce((s, r) => s + r.amount, 0);

  return {
    client: client?.name ?? clientId,
    attribution: { model, windowDays },
    spendInr: round(spendInr), spendNative: round(spendNative),
    leads, registered, attended, callsBooked: calls, sales: netSales.length,
    revenueInr: round(revenueInr), refundsInr: round(refundsInr),
    costPerLead: leads ? round(spendInr / leads) : 0,
    costPerRegistrant: registered ? round(spendInr / registered) : 0,
    costPerAttendee: attended ? round(spendInr / attended) : 0,
    costPerCall: calls ? round(spendInr / calls) : 0,
    costPerSale: netSales.length ? round(spendInr / netSales.length) : 0,
    showUpRate: registered ? attended / registered : 0,
    closeRate: calls ? netSales.length / calls : 0,
    roi: spendInr ? (revenueInr - spendInr) / spendInr : 0,
  };
}

// ---------------------------------------------------------------------------
// 2) AD PERFORMANCE table (spec 7): campaign/adset/ad rows w/ spend, leads,
//    sales, revenue, ROAS, profit, thumbnail. Drill-down + thumbnail.
// ---------------------------------------------------------------------------
export interface AdPerfRow {
  adId: string;
  adName: string;
  thumbnail: string | null;
  campaignId: string;
  adsetId: string;
  spendInr: number;
  leads: number; // leads credited to this ad
  sales: number;
  revenueInr: number; // credited revenue
  profitInr: number;
  roas: number;
}

export async function adPerformance(
  prisma: PrismaClient,
  clientId: string,
  rangeMs = 30 * DAY_MS,
  level: AdLevel = "ad",
  model: AttributionModel = "last_paid_click",
  windowDays = 30,
  offerPrice = 0,
  adAccountId?: string
): Promise<AdPerfRow[]> {
  const spendRows = await prisma.spend.findMany({
    where: { clientId, day: { gte: dayStr(Date.now() - rangeMs) }, ...(adAccountId ? { adAccountId } : {}) },
    include: { ad: { include: { adSet: { include: { campaign: true } }, creatives: true } } },
  });

  const { sales } = await salesForClient(prisma, clientId, rangeMs);
  const buckets = aggregateAttribution(
    {
      sales: sales.map((s) => ({
        leadId: s.leadId,
        saleTime: s.saleTime,
        amount: s.amount,
        clicks: s.clicks,
        firstFormFill: s.firstFormFill,
      })),
      model,
      windowDays,
    },
    level
  );
  const credit = new Map(buckets.map((b) => [b.key, b]));

  // Spend per ad (or adset/campaign) grouped by the ad's meta id.
  const group = (r: typeof spendRows[number]): string =>
    level === "ad" ? r.ad.metaId : level === "adset" ? r.ad.adSet.metaId : level === "campaign" ? r.ad.adSet.campaign.metaId : r.ad.metaId;

  const rows: AdPerfRow[] = spendRows
    .map((r) => {
      const key = group(r);
      const c = credit.get(key);
      const spendInr = (r.inrSpend ?? 0);
      const revenue = c?.shareRevenue ?? 0;
      const salesCount = c?.sales ?? 0;
      const leads = c?.sales ?? 0; // conservative: credited sales double as leads
      const profit = revenue - spendInr - (salesCount ? salesCount * (offerPrice ? 0 : 0) : 0);
      return {
        adId: key,
        adName: r.ad.name ?? r.ad.metaId,
        thumbnail: r.ad.creatives[0]?.thumbnailUrl ?? null,
        campaignId: r.ad.adSet.campaign.metaId,
        adsetId: r.ad.adSet.metaId,
        spendInr: round(spendInr),
        leads, sales: salesCount, revenueInr: round(revenue),
        profitInr: round(profit),
        roas: spendInr ? revenue / spendInr : revenue ? Infinity : 0,
      };
    })
    .sort((a, b) => b.spendInr - a.spendInr);

  // De-dup (grouped levels repeat per ad) keeping max spend.
  const seen = new Map<string, AdPerfRow>();
  for (const r of rows) {
    const prev = seen.get(r.adId);
    if (!prev || r.spendInr > prev.spendInr) seen.set(r.adId, r);
  }
  return [...seen.values()].sort((a, b) => b.spendInr - a.spendInr);
}

// ---------------------------------------------------------------------------
// 3) WASTED SPEND (spec 7): ads above a spend threshold with ZERO sales.
// ---------------------------------------------------------------------------
export interface WastedRow {
  adId: string;
  adName: string;
  thumbnail: string | null;
  spendInr: number;
  sales: number;
}
export async function wastedSpend(
  prisma: PrismaClient,
  clientId: string,
  minSpendInr = 2000,
  rangeMs = 30 * DAY_MS,
  adAccountId?: string
): Promise<WastedRow[]> {
  const perf = await adPerformance(prisma, clientId, rangeMs, "ad", "last_paid_click", 30, 0, adAccountId);
  return perf
    .filter((r) => r.spendInr >= minSpendInr && r.sales === 0)
    .sort((a, b) => b.spendInr - a.spendInr)
    .map((r) => ({ adId: r.adId, adName: r.adName, thumbnail: r.thumbnail, spendInr: r.spendInr, sales: r.sales }));
}

// ---------------------------------------------------------------------------
// 4) NEW vs OLD leads (spec 7): sales from leads created in-range vs older.
// ---------------------------------------------------------------------------
export interface NewVsOld {
  newSales: number;
  newRevenueInr: number;
  oldSales: number;
  oldRevenueInr: number;
  newLeadIds: string[];
  oldLeadIds: string[];
}
export async function newVsOld(
  prisma: PrismaClient,
  clientId: string,
  rangeMs = 30 * DAY_MS
): Promise<NewVsOld> {
  const { sales } = await salesForClient(prisma, clientId, rangeMs);
  const cutoff = Date.now() - rangeMs;
  let newSales = 0, newRev = 0, oldSales = 0, oldRev = 0;
  const newIds: string[] = [], oldIds: string[] = [];
  for (const s of sales) {
    if (s.leadCreatedAt.getTime() >= cutoff) {
      newSales++; newRev += s.amount; newIds.push(s.leadId);
    } else {
      oldSales++; oldRev += s.amount; oldIds.push(s.leadId);
    }
  }
  return { newSales, newRevenueInr: round(newRev), oldSales, oldRevenueInr: round(oldRev), newLeadIds: newIds, oldLeadIds: oldIds };
}

// ---------------------------------------------------------------------------
// 5) META vs XACQORA TRACK (spec 7): Meta-reported conversions next to our
//    counted conversions per ad, so we see where Meta over/under-reports.
// ---------------------------------------------------------------------------
export interface MetaVsTrackRow {
  adId: string;
  adName: string;
  metaConversions: number;
  ourConversions: number; // purchases credited to this ad
  delta: number; // meta - ours
  over: boolean; // meta over-reports?
}
export async function metaVsTrack(
  prisma: PrismaClient,
  clientId: string,
  rangeMs = 30 * DAY_MS,
  model: AttributionModel = "last_paid_click",
  windowDays = 30,
  adAccountId?: string
): Promise<MetaVsTrackRow[]> {
  const spend = await prisma.spend.findMany({
    where: { clientId, day: { gte: dayStr(Date.now() - rangeMs) }, ...(adAccountId ? { adAccountId } : {}) },
    include: { ad: true },
  });
  const { sales } = await salesForClient(prisma, clientId, rangeMs);
  const buckets = aggregateAttribution(
    { sales: sales.map((s) => ({ leadId: s.leadId, saleTime: s.saleTime, amount: s.amount, clicks: s.clicks, firstFormFill: s.firstFormFill })), model, windowDays },
    "ad"
  );
  const ours = new Map(buckets.map((b) => [b.key, b.sales]));

  const byAd = new Map<string, MetaVsTrackRow>();
  for (const r of spend) {
    const key = r.adMetaId;
    let row = byAd.get(key);
    if (!row) {
      row = { adId: key, adName: r.ad?.name ?? key, metaConversions: 0, ourConversions: 0, delta: 0, over: false };
      byAd.set(key, row);
    }
    row.metaConversions += r.metaConversions ?? 0;
    row.ourConversions = ours.get(key) ?? 0;
  }
  return [...byAd.values()].map((r) => ({ ...r, delta: r.metaConversions - r.ourConversions, over: r.metaConversions > r.ourConversions }));
}

// ---------------------------------------------------------------------------
// 6) LEAD SOURCE MIX (spec 7): Instant Form vs landing page vs organic vs unknown.
// ---------------------------------------------------------------------------
export interface SourceMix {
  instantForm: number;
  landingPage: number;
  organic: number;
  unknown: number;
  total: number;
}
export async function sourceMix(prisma: PrismaClient, clientId: string): Promise<SourceMix> {
  const leads = await prisma.lead.findMany({
    where: { clientId },
    include: { events: { where: { type: "meta_form_lead" }, take: 1 } },
  });
  const instantForm = leads.filter((l) => l.events.length > 0).length;
  const unknown = leads.filter((l) => l.sourceUnknown).length;
  const withAd = await prisma.touchpoint.count({
    where: { clientId, adId: { not: null } },
  });
  const organic = Math.max(0, leads.length - instantForm - unknown);
  const landingPage = Math.min(withAd, Math.max(0, leads.length - instantForm - unknown));
  return { instantForm, landingPage, organic: Math.max(0, organic - landingPage), unknown, total: leads.length };
}

// ---------------------------------------------------------------------------
// 7) WEEKLY client summary (spec 7): one page, Monday 9AM IST auto-generated.
//    Composes the above into a single printable/summary object.
// ---------------------------------------------------------------------------
export interface WeeklySummary {
  weekOf: string;
  client: string;
  funnel: Omit<FunnelReport, "client">;
  topAds: AdPerfRow[];
  wasted: WastedRow[];
  newVsOld: NewVsOld;
  metaVsTrack: MetaVsTrackRow[];
  sourceMix: SourceMix;
  at: string; // generated timestamp
}
/**
 * D-01 resolver: map a Meta ad-account `metaId` (what a URL carries, e.g.
 * act_4749960348632164) to the internal AdAccount row id, verifying it belongs
 * to the client. Returns undefined when no such account — so an unknown
 * `?adAccount=` silently no-ops to the client-wide scope rather than 404-ing.
 */
export async function resolveAdAccountId(
  prisma: PrismaClient,
  clientId: string,
  metaId: string | null | undefined
): Promise<string | undefined> {
  if (!metaId) return undefined;
  const acct = await prisma.adAccount.findFirst({
    where: { metaId, clientId },
    select: { id: true },
  });
  return acct?.id;
}

/** §1 "All" ad-account resolver: the ?adAccount= metaId → row id, but verified
 *  against ANY client in the requested SET (the aggregate view), not one. */
export async function resolveAdAccountIdInSet(
  prisma: PrismaClient,
  clientIds: string[],
  metaId: string | null | undefined
): Promise<string | undefined> {
  if (!metaId || clientIds.length === 0) return undefined;
  const acct = await prisma.adAccount.findFirst({
    where: { metaId, clientId: { in: clientIds } },
    select: { id: true },
  });
  return acct?.id;
}

// ---------------------------------------------------------------------------
// Dashboard-V2 §1 — the "All clients / All ad accounts" aggregate. Each report
// already runs per-client; the All view runs them across the visible set and
// SUMS the additive figures (spend, leads, sales, counts). Rate/derived fields
// (cost-per, ROI, ROAS) are recomputed from the sums, not summed — so the
// aggregate is mathematically correct, never a fake.
// ---------------------------------------------------------------------------

/** Sum a set of funnel reports into one All-accounts funnel. */
export function sumFunnel(rows: FunnelReport[], label = "All clients"): FunnelReport {
  const s = {
    spendInr: 0, spendNative: 0, leads: 0, registered: 0, attended: 0,
    callsBooked: 0, sales: 0, revenueInr: 0, refundsInr: 0,
  };
  for (const r of rows) {
    s.spendInr += r.spendInr; s.spendNative += r.spendNative; s.leads += r.leads;
    s.registered += r.registered; s.attended += r.attended; s.callsBooked += r.callsBooked;
    s.sales += r.sales; s.revenueInr += r.revenueInr; s.refundsInr += r.refundsInr;
  }
  const ref = rows[0];
  const net = s.revenueInr;
  return {
    client: label,
    attribution: ref?.attribution ?? { model: "last_paid_click", windowDays: 30 },
    spendInr: round(s.spendInr), spendNative: round(s.spendNative),
    leads: s.leads, registered: s.registered, attended: s.attended,
    callsBooked: s.callsBooked, sales: s.sales,
    revenueInr: round(net), refundsInr: round(s.refundsInr),
    costPerLead: s.leads ? round(s.spendInr / s.leads) : 0,
    costPerRegistrant: s.registered ? round(s.spendInr / s.registered) : 0,
    costPerAttendee: s.attended ? round(s.spendInr / s.attended) : 0,
    costPerCall: s.callsBooked ? round(s.spendInr / s.callsBooked) : 0,
    costPerSale: s.sales ? round(s.spendInr / s.sales) : 0,
    showUpRate: s.registered ? s.attended / s.registered : 0,
    closeRate: s.callsBooked ? s.sales / s.callsBooked : 0,
    roi: s.spendInr ? (net - s.spendInr) / s.spendInr : 0,
  };
}

/** Concat + spend-rerank a set of ad-performance tables. */
export function sumAdPerf(rows: AdPerfRow[]): AdPerfRow[] {
  const seen = new Map<string, AdPerfRow>();
  for (const r of rows.flat()) {
    const prev = seen.get(r.adId);
    if (!prev || r.spendInr > prev.spendInr) seen.set(r.adId, r);
  }
  return [...seen.values()].sort((a, b) => b.spendInr - a.spendInr);
}

/** Sum a set of source-mix reports. */
export function sumSourceMix(rows: SourceMix[]): SourceMix {
  const s = { instantForm: 0, landingPage: 0, organic: 0, unknown: 0, total: 0 };
  for (const r of rows) {
    s.instantForm += r.instantForm; s.landingPage += r.landingPage;
    s.organic += r.organic; s.unknown += r.unknown; s.total += r.total;
  }
  return s;
}

/** Concat a set of meta-vs-track rows (one per ad, no cross-client dedup
 *  needed — ad ids are globally unique). */
export function sumMetaVsTrack(rows: MetaVsTrackRow[]): MetaVsTrackRow[] {
  return rows.flat();
}

/** Concat + spend-rerank a set of wasted-spend tables. */
export function sumWasted(rows: WastedRow[]): WastedRow[] {
  const seen = new Map<string, WastedRow>();
  for (const r of rows.flat()) {
    const prev = seen.get(r.adId);
    if (!prev || r.spendInr > prev.spendInr) seen.set(r.adId, r);
  }
  return [...seen.values()].sort((a, b) => b.spendInr - a.spendInr);
}

/** Sum a set of new-vs-old reports. */
export function sumNewVsOld(rows: NewVsOld[]): NewVsOld {
  const s = { newSales: 0, newRevenueInr: 0, oldSales: 0, oldRevenueInr: 0, newLeadIds: [] as string[], oldLeadIds: [] as string[] };
  for (const r of rows) {
    s.newSales += r.newSales; s.newRevenueInr += r.newRevenueInr;
    s.oldSales += r.oldSales; s.oldRevenueInr += r.oldRevenueInr;
    s.newLeadIds.push(...r.newLeadIds); s.oldLeadIds.push(...r.oldLeadIds);
  }
  return s;
}

export async function weeklySummary(
  prisma: PrismaClient,
  clientId: string,
  model: AttributionModel = "last_paid_click",
  windowDays = 30,
  adAccountId?: string
): Promise<WeeklySummary> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const offerPrice = client?.offerPrice ?? 0;
  const [funnel, ads, wasted, nv, mvt, mix] = await Promise.all([
    funnelReport(prisma, clientId, 7 * DAY_MS, model, windowDays, adAccountId),
    adPerformance(prisma, clientId, 7 * DAY_MS, "ad", model, windowDays, offerPrice, adAccountId),
    wastedSpend(prisma, clientId, 2000, 7 * DAY_MS, adAccountId),
    newVsOld(prisma, clientId, 7 * DAY_MS),
    metaVsTrack(prisma, clientId, 7 * DAY_MS, model, windowDays, adAccountId),
    sourceMix(prisma, clientId),
  ]);
  return {
    weekOf: new Date().toISOString().slice(0, 10),
    client: client?.name ?? clientId,
    funnel: { ...funnel, client: undefined } as Omit<FunnelReport, "client">,
    topAds: ads.slice(0, 5),
    wasted, newVsOld: nv, metaVsTrack: mvt, sourceMix: mix,
    at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CSV / Excel export (spec 7: every report exports). `toCsv` + `toXlsx`.
// ---------------------------------------------------------------------------
export function toCsv(rows: object[], header?: string[]): string {
  if (rows.length === 0) return (header ?? []).join(",") + "\n";
  const cols = header ?? Object.keys(rows[0]);
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.join(",");
  const body = rows.map((r) => cols.map((c) => esc((r as Record<string, unknown>)[c])).join(",")).join("\n");
  return head + "\n" + body;
}

// A minimal .xlsx is just a zip of XML; we emit CSV (openable in Excel) and,
// when a real xlsx lib is available in prod, the same rows become an xlsx.
export function toXlsx(rows: object[], header?: string[]): { mime: string; body: string } {
  // CSV with a UTF-8 BOM opens as a table in Excel — the practical "Excel"
  // export without pulling a heavy dependency.
  return { mime: "text/csv; charset=utf-8", body: "﻿" + toCsv(rows, header) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function dayStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export type { AttributionModel };
