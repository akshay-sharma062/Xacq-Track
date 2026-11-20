/**
 * D-17 — admin tracker: the IP ANALYTICS tab (Phase 4).
 *
 *   GET /api/admin/tracker/ip?ip=<suffix>&project=<id>
 *     → { ip, eventCount, uniqueVisitors, firstSeen, lastSeen,
 *         deviceBreakdown }
 *
 * `ip` is a SUFFIX search (the spec's "search box for a specific IP"); an
 * empty/omitted `ip` is 400 (never "all IPs" — that's the visitors table).
 * Scoped to one workspace project (or all workspace projects when omitted).
 * Gated on `admin_tracker`.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate } from "@/lib/api-utils";
import { trackerIpAnalytics, trackerScope, workspaceProjectIds } from "@/lib/tracker";

export async function GET(req: NextRequest) {
  const g = await gate("admin_tracker");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const sp = req.nextUrl.searchParams;
  const ipSuffix = (sp.get("ip") ?? "").trim();
  if (!ipSuffix) {
    return NextResponse.json({ error: "'ip' required (the IP to analyse)" }, { status: 400 });
  }
  const projectParam = sp.get("project") || undefined;
  // Device Track "filter by client": an optional ?client=<id> narrows the
  // all-projects view to that client's tracking projects.
  const clientParam = sp.get("client") || undefined;
  const ids = projectParam
    ? await trackerScope(prisma, s.workspaceId, projectParam).then((r) =>
        r.error ? [] : r.ids
      )
    : await workspaceProjectIds(prisma, s.workspaceId, clientParam);

  const result = await trackerIpAnalytics(prisma, ids, ipSuffix);
  // Nothing for this IP is a HONEST empty, not a 404 (a suffix can simply
  // have no events yet).
  return NextResponse.json(result);
}
