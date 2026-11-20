/**
 * D-17 — admin tracker: the PER-PROJECT dashboard + install snippet + status.
 *
 *   GET /api/admin/tracker/<projectId>?window=<days>
 *     → { project, dashboard, snippet, base, visitorCount }
 *
 * The project must belong to this workspace (a foreign-workspace id is a
 * clean 404 "unknown project", never a leak). The install snippet uses the
 * real public base (resolveWebhookBase precedence). Gated on `admin_tracker`.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate } from "@/lib/api-utils";
import {
  trackerDashboard,
  trackerInstallSnippet,
  trackerScope,
} from "@/lib/tracker";
import { currentPublicBase } from "@/lib/live-host";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const g = await gate("admin_tracker");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const { projectId } = await params;
  const scope = await trackerScope(prisma, s.workspaceId, projectId);
  if (scope.error) {
    return NextResponse.json({ error: scope.error }, { status: 404 });
  }
  const project = await prisma.trackingProject.findUnique({
    where: { id: projectId },
    include: { client: { select: { id: true, name: true } } },
  });
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });

  const windowDays = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get("window")) || 30));
  const dashboard = await trackerDashboard(prisma, [projectId], { windowDays });
  const visitorCount = await prisma.trackedVisitor.count({ where: { projectId } });

  // D-17 live-host: the snippet resolves the SELF-CAPTURED live host
  // (Workspace.liveHost, if fresh > .env tiers > localhost-dev), never a
  // stale .env value.
  const base = (await currentPublicBase({ workspaceId: s.workspaceId })).base;
  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      landingPageName: project.landingPageName,
      landingPageUrl: project.landingPageUrl,
      description: project.description,
      status: project.status,
      clientId: project.clientId,
      clientName: project.client?.name ?? null,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    dashboard,
    visitorCount,
    base,
    snippet: trackerInstallSnippet(project.id, base),
  });
}
