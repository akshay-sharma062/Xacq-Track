/**
 * D-17 — admin tracker: the VISITOR TABLE (Phase 4).
 *
 *   GET /api/admin/tracker/<projectId>/visitors?search=&device=&country=&kind=&page=
 *   GET /api/admin/tracker/visitors?…            (no projectId = ALL workspace projects)
 *     → { rows, total, page, pageSize, masked }
 *
 * IP display is role-aware: owner/admin get the full IP, every other role
 * gets it masked to the last-octet form (spec §10) — the route applies
 * maskIp per role before it ever leaves the server. `search` is an IP SUFFIX
 * match ("1.2.3") or a visitorId substring; `device`/`country`/`kind` filter;
 * the sort is totalVisits desc (default) and the page is 25 rows.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate } from "@/lib/api-utils";
import {
  trackerVisitors,
  trackerScope,
  workspaceProjectIds,
  maskIp,
} from "@/lib/tracker";

export async function GET(req: NextRequest) {
  const g = await gate("admin_tracker");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const sp = req.nextUrl.searchParams;
  const projectParam = sp.get("project") || undefined;
  // Device Track "filter by client": an optional ?client=<id> narrows the
  // all-projects view to that client's tracking projects.
  const clientParam = sp.get("client") || undefined;
  // All-projects (no ?project) or a single in-workspace project.
  const ids = projectParam
    ? await trackerScope(prisma, s.workspaceId, projectParam).then((r) =>
        r.error ? [] : r.ids
      )
    : await workspaceProjectIds(prisma, s.workspaceId, clientParam);

  const q = {
    search: sp.get("search") || undefined,
    device: sp.get("device") || undefined,
    country: sp.get("country") || undefined,
    kind: (sp.get("kind") as "new" | "returning" | null) || undefined,
    page: Number(sp.get("page")) || 1,
  };

  const result = await trackerVisitors(prisma, ids, q);
  // The IP is masked for NON-owner/admin roles (spec §10) — applied server-side
  // so the raw IP never reaches a non-privileged client.
  const privileged = s.role === "owner" || s.role === "admin";
  const rows = result.rows.map((r) => ({
    ...r,
    ip: maskIp(r.ip, { role: s.role }),
  }));

  return NextResponse.json({
    rows,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    masked: !privileged, // the UI shows a "masked" badge when this is true
  });
}
