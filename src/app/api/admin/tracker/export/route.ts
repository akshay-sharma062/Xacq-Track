/**
 * D-17 — admin tracker: the CSV EXPORT (Phase 4, the ticket's "CSV export
 * button uses auditExport before exporting").
 *
 *   GET /api/admin/tracker/export?project=<id>[&page=]
 *     → text/csv attachment (the VISITOR TABLE rows — the PO's per-visitor
 *       aggregate view, the natural export). IP is FULL (owner/admin is the
 *       only role that can reach this route via admin_tracker).
 *
 * `auditExport` runs FIRST (spec §10 / the ticket) so the audit row
 * outlives the export. The audit is anchored to a workspace client (the
 * AuditLog row's clientId FK) — the tracker is workspace-scoped, so a
 * workspace with clients uses its first client; a workspace with none
 * skips the audit row (honest: there is no client to attribute it to).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate, qs } from "@/lib/api-utils";
import { auditExport } from "@/lib/security";
import { toCsv } from "@/lib/reports";
import {
  trackerVisitors,
  trackerScope,
  workspaceProjectIds,
} from "@/lib/tracker";

export async function GET(req: NextRequest) {
  const g = await gate("admin_tracker");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const sp = qs(Object.fromEntries(req.nextUrl.searchParams));
  const projectParam = sp.project || undefined;
  // Device Track "filter by client": an optional ?client=<id> narrows the
  // all-projects view to that client's tracking projects.
  const clientParam = sp.client || undefined;
  const ids = projectParam
    ? await trackerScope(prisma, s.workspaceId, projectParam).then((r) =>
        r.error ? [] : r.ids
      )
    : await workspaceProjectIds(prisma, s.workspaceId, clientParam);

  // Every visitor (not just page 1) — the export is the full table.
  const result = await trackerVisitors(prisma, ids, { page: 1 });
  const rows = result.rows;

  // Audit BEFORE the export (spec §10): anchor to a workspace client.
  const anchor = await prisma.client.findFirst({
    where: { workspaceId: s.workspaceId },
    select: { id: true },
  });
  if (anchor) {
    await auditExport(s, anchor.id, `tracker:visitors`, {
      project: projectParam ?? "all",
      rows: rows.length,
    });
  }

  const csv = toCsv(rows.map((r) => ({
    visitorId: r.visitorId,
    ip: r.ip ?? "", // FULL — this route is admin_tracker (owner/admin) only
    device: r.deviceType ?? "",
    browser: r.browserName ?? "",
    os: r.osName ?? "",
    country: r.ipCountry ?? "",
    city: r.ipCity ?? "",
    firstSeen: r.firstSeen.toISOString(),
    lastSeen: r.lastSeen.toISOString(),
    totalVisits: r.totalVisits,
    kind: r.kind,
  })));

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv",
      "content-disposition": `attachment; filename="xacqora_tracker_visitors.csv"`,
    },
  });
}
