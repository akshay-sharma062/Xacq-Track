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
import { getSession, resolveClient } from "@/lib/api-utils";
import {
  funnelReport, adPerformance, wastedSpend, newVsOld, metaVsTrack, sourceMix,
  weeklySummary, toCsv, toXlsx,
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
  const clientId = await resolveClient(s, sp.get("client"));
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const offerPrice = client?.offerPrice ?? 0;

  let data: unknown;
  let csv: string[] = [];
  switch (key) {
    case "funnel": data = await funnelReport(prisma, clientId, 30 * 86_400_000, model, windowDays); break;
    case "ad_perf": data = await adPerformance(prisma, clientId, 30 * 86_400_000, "ad", model, windowDays, offerPrice); break;
    case "wasted_spend": data = await wastedSpend(prisma, clientId, 2000, 30 * 86_400_000); break;
    case "new_vs_old": data = await newVsOld(prisma, clientId, 30 * 86_400_000); break;
    case "meta_vs_track": data = await metaVsTrack(prisma, clientId, 30 * 86_400_000, model, windowDays); break;
    case "source_mix": data = await sourceMix(prisma, clientId); break;
    case "weekly": data = await weeklySummary(prisma, clientId, model, windowDays); break;
    default: return NextResponse.json({ error: `unknown report '${key}'` }, { status: 400 });
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

  return NextResponse.json({ key, client: client?.name, attribution: { model, windowDays }, data });
}
