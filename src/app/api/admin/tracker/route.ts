/**
 * D-17 — admin tracker: the project list + create (Phase 4, admin-only).
 *
 *   GET  /api/admin/tracker → { projects: ProjectSummary[] }
 *   POST /api/admin/tracker { name, landingPageName, landingPageUrl, description? }
 *      → 200 { id, snippet, ... } (the install snippet with the REAL base URL)
 *
 * Gated on `admin_tracker` (owner/admin only — src/lib/session.ts). The
 * install snippet reads the PUBLIC_BASE_URL (.env) / Workspace.liveHost
 * base server-side — the browser can't see .env, so the server builds it.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate } from "@/lib/api-utils";
import {
  createTrackingProject,
  trackerProjectSummaries,
  trackerInstallSnippet,
} from "@/lib/tracker";
import { currentPublicBase } from "@/lib/live-host";

/**
 * The public base for the install snippet. D-17 live-host: the SELF-CAPTURED
 * Workspace.liveHost (fresh) > .env tiers > localhost-dev (via
 * currentPublicBase's precedence), NOT a hardcoded/stale .env value — the
 * quick-tunnel host rotates on every cloudflared restart, so a stale
 * PUBLIC_BASE_URL 404s at FlexiFunnels. The browser can't see .env, so the
 * server resolves it here.
 */
async function trackerBase(workspaceId: string): Promise<string> {
  const base = await currentPublicBase({ workspaceId });
  return base.base;
}

export async function GET(req: NextRequest) {
  const g = await gate("admin_tracker");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;
  const projects = await trackerProjectSummaries(prisma, s.workspaceId);
  // Per-project install snippets (the Device Track "show me the script" case):
  // every listed project carries the FULL snippet to paste into its landing
  // page — built from the SAME live-host base (self-captured liveHost > .env
  // tiers > localhost-dev) the create response uses, so the displayed script
  // is the one that actually works.
  const base = await trackerBase(s.workspaceId);
  return NextResponse.json({
    base,
    projects: projects.map((p) => ({
      ...p,
      snippet: trackerInstallSnippet(p.id, base),
    })),
  });
}

export async function POST(req: NextRequest) {
  const g = await gate("admin_tracker");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const b = await req.json().catch(() => ({}));
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const landingPageName =
    typeof b.landingPageName === "string" ? b.landingPageName.trim() : "";
  const landingPageUrl =
    typeof b.landingPageUrl === "string" ? b.landingPageUrl.trim() : "";
  const description =
    typeof b.description === "string" ? b.description : null;
  // The client this project tracks (the Device Track "filter by client" axis).
  // Omitted/blank = unassigned (all-clients view).
  const clientId =
    typeof b.clientId === "string" && b.clientId.trim() ? b.clientId.trim() : null;
  if (!name || !landingPageName || !landingPageUrl) {
    return NextResponse.json(
      { error: "'name' + 'landingPageName' + 'landingPageUrl' required" },
      { status: 400 }
    );
  }

  let created;
  try {
    created = await createTrackingProject(prisma, {
      workspaceId: s.workspaceId,
      name,
      landingPageName,
      landingPageUrl,
      description,
      clientId,
      createdBy: s.userId,
    });
  } catch (e: any) {
    // The (workspaceId, name) unique constraint: a duplicate name is 409.
    if (e?.code === "P2002") {
      return NextResponse.json(
        { error: `a tracking project named '${name}' already exists in this workspace` },
        { status: 409 }
      );
    }
    throw e;
  }

  const base = await trackerBase(s.workspaceId);
  return NextResponse.json({
    id: created.id,
    name: created.name,
    clientId,
    status: "active",
    base,
    snippet: trackerInstallSnippet(created.id, base),
  });
}
