/**
 * D-17 — admin tracker: the all-projects AGGREGATE dashboard (Phase 4).
 *
 *   GET /api/admin/tracker/overview?window=<days>
 *     → { dashboard, windowDays }
 *
 * All-projects = every TrackingProject in this workspace (the tracker is a
 * per-workspace module). `window` scopes the time-series + the window
 * cards; the total cards are lifetime totals. Gated on `admin_tracker`.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate } from "@/lib/api-utils";
import { workspaceProjectIds, trackerDashboard } from "@/lib/tracker";

export async function GET(req: NextRequest) {
  const g = await gate("admin_tracker");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const windowDays = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get("window")) || 30));
  // Device Track "filter by client": an optional ?client=<id> narrows the
  // aggregate to that client's tracking projects (absent = all workspace
  // projects, the all-clients view).
  const clientParam = req.nextUrl.searchParams.get("client") || undefined;
  const ids = await workspaceProjectIds(prisma, s.workspaceId, clientParam);
  const dashboard = await trackerDashboard(prisma, ids, { windowDays });
  return NextResponse.json({ dashboard, windowDays });
}
