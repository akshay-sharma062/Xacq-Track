/**
 * Reports (spec 7). One route serves every report by `?key=`; each says which
 * attribution model + window it used, counts revenue net of refunds, and can
 * export CSV/Excel (spec 7: "every report can export CSV and Excel").
 *
 *   GET /api/reports?key=funnel|ad_perf|wasted_spend|new_vs_old|meta_vs_track|
 *       source_mix|weekly&client=&model=&window=&export=csv
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, resolveClientSet } from "@/lib/api-utils";
import {
  funnelReport, adPerformance, adSetPerformance, sumAdSets, wastedSpend, newVsOld, metaVsTrack, sourceMix,
  weeklySummary, toCsv, toXlsx, resolveAdAccountId,
  resolveAdAccountIdInSet, sumFunnel, sumAdPerf, sumSourceMix, sumMetaVsTrack, sumNewVsOld, sumWasted,
} from "@/lib/reports";
import { auditExport } from "@/lib/security";
import { AttributionModel } from "@/lib/types";

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const key = sp.get("key") ?? "funnel";
  const model = (sp.get("model") as AttributionModel) ?? "last_paid_click";
  const windowDays = Number(sp.get("window")) || 30;
  const exportAs = sp.get("export");

  // §1 "All" default: no client (or ?client=all) → aggregate across the whole
  // visible client set; a specific client id → single-client (unchanged).
  const clientSet = await resolveClientSet(s, sp.get("client") ?? "all");
  if (clientSet.length === 0) return NextResponse.json({ error: "no visible client" }, { status: 403 });
  const isAll = clientSet.length > 1 && (sp.get("client") === null || sp.get("client") === "all");
  const clientId = clientSet[0]; // representative id (offerPrice fallback + single-client path)

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const offerPrice = client?.offerPrice ?? 0;
  // D-01 ad-account filter: ?adAccount=<metaId> scopes the SPEND-family reports
  // to one Meta ad account (verified it belongs to the client/set — unknown id
  // is a safe no-op to "all").
  const adAccountId = isAll
    ? await resolveAdAccountIdInSet(prisma, clientSet, sp.get("adAccount"))
    : await resolveAdAccountId(prisma, clientId, sp.get("adAccount"));
  const run = <T>(fn: (cid: string) => Promise<T>, ids: string[]): Promise<T[]> =>
    Promise.all(ids.map((cid) => fn(cid)));

  let data: unknown;
  let clientLabel = client?.name ?? clientId;
  if (isAll) {
    switch (key) {
      case "funnel": data = sumFunnel((await run((c) => funnelReport(prisma, c, 30 * 86_400_000, model, windowDays, adAccountId), clientSet)).flat(), "All clients"); clientLabel = "All clients"; break;
      case "ad_perf": data = sumAdPerf((await run((c) => adPerformance(prisma, c, 30 * 86_400_000, "ad", model, windowDays, offerPrice, adAccountId), clientSet)).flat()); clientLabel = "All clients"; break;
      case "ad_set": data = sumAdSets((await run((c) => adSetPerformance(prisma, c, 30 * 86_400_000, model, windowDays, adAccountId), clientSet)).flat()); clientLabel = "All clients"; break;
      case "wasted_spend": data = sumWasted((await run((c) => wastedSpend(prisma, c, 2000, 30 * 86_400_000, adAccountId), clientSet)).flat()).slice(0, 200); clientLabel = "All clients"; break;
      case "new_vs_old": data = sumNewVsOld((await run((c) => newVsOld(prisma, c, 30 * 86_400_000), clientSet)).flat()); clientLabel = "All clients"; break;
      case "meta_vs_track": data = sumMetaVsTrack((await run((c) => metaVsTrack(prisma, c, 30 * 86_400_000, model, windowDays, adAccountId), clientSet)).flat()); clientLabel = "All clients"; break;
      case "source_mix": data = sumSourceMix((await run((c) => sourceMix(prisma, c), clientSet)).flat()); clientLabel = "All clients"; break;
      case "weekly": data = sumFunnel((await run((c) => funnelReport(prisma, c, 7 * 86_400_000, model, windowDays, adAccountId), clientSet)).flat(), "All clients (7d)"); clientLabel = "All clients"; break;
      default: return NextResponse.json({ error: `unknown report '${key}'` }, { status: 400 });
    }
  } else {
    switch (key) {
      case "funnel": data = await funnelReport(prisma, clientId, 30 * 86_400_000, model, windowDays, adAccountId); break;
      case "ad_perf": data = await adPerformance(prisma, clientId, 30 * 86_400_000, "ad", model, windowDays, offerPrice, adAccountId); break;
      case "ad_set": data = await adSetPerformance(prisma, clientId, 30 * 86_400_000, model, windowDays, adAccountId); break;
      case "wasted_spend": data = await wastedSpend(prisma, clientId, 2000, 30 * 86_400_000, adAccountId); break;
      case "new_vs_old": data = await newVsOld(prisma, clientId, 30 * 86_400_000); break;
      case "meta_vs_track": data = await metaVsTrack(prisma, clientId, 30 * 86_400_000, model, windowDays, adAccountId); break;
      case "source_mix": data = await sourceMix(prisma, clientId); break;
      case "weekly": data = await weeklySummary(prisma, clientId, model, windowDays, adAccountId); break;
      default: return NextResponse.json({ error: `unknown report '${key}'` }, { status: 400 });
    }
  }

  // Every number in the array reports exports to CSV/Excel (spec 7).
  const asArray = Array.isArray(data) ? data : [];
  if (exportAs === "csv" || exportAs === "excel") {
    const { body } = toXlsx(asArray as object[]);
    await auditExport(s, clientId, `report:${key}`, { format: exportAs, rows: asArray.length, model, windowDays });
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": exportAs === "excel" ? "application/vnd.ms-excel" : "text/csv",
        "Content-Disposition": `attachment; filename="xacqora_${key}.csv"`,
      },
    });
  }

  return NextResponse.json({ key, client: clientLabel, attribution: { model, windowDays }, data });
}
