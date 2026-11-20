/**
 * D-17 — admin tracker: the "Disable / Enable" toggle for a project
 * (Phase 4). An INACTIVE project's /api/tracker/ingest returns 204 and
 * writes nothing (the tracker JS swallows it), so disabling stops the
 * capture without losing the historical rows.
 *
 *   POST /api/admin/tracker/<projectId>/status { status: "active"|"inactive" }
 *     → 200 { found, status }   ·  404 unknown project   ·  400 bad value
 *
 * Gated on `admin_tracker`; the project must be in this workspace.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate } from "@/lib/api-utils";
import { setProjectStatus, trackerScope } from "@/lib/tracker";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const g = await gate("admin_tracker");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const { projectId } = await params;
  const scope = await trackerScope(prisma, s.workspaceId, projectId);
  if (scope.error) return NextResponse.json({ error: scope.error }, { status: 404 });

  const b = await req.json().catch(() => ({}));
  const status = b.status;
  if (status !== "active" && status !== "inactive") {
    return NextResponse.json({ error: "'status' must be 'active' or 'inactive'" }, { status: 400 });
  }
  const res = await setProjectStatus(prisma, projectId, status);
  if (!res.found) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  return NextResponse.json({ id: projectId, status: res.status });
}
