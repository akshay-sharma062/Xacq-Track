/**
 * D-15 — "Refresh URLs": re-point every ACTIVE webhook connection's
 * inboundUrl to the current live host (admin-only).
 *
 * Quick-tunnel subdomains ROTATE on every cloudflared restart, so a stored
 * inboundUrl can point at a DEAD subdomain while the path (?client=&conn=),
 * the per-connection secret, and the platform are all still valid — only the
 * host is stale. This action is how the PO self-heals that:
 *
 *   1. rewrite ONLY the host substring on every ACTIVE WebhookEndpoint
 *      (refreshWebhookUrlsToHost — idempotent: a second run changes 0 rows;
 *      the endpointSecret / keyHash / connection log are never touched);
 *   2. PERSIST that host to Workspace.liveHost — the known source the GET
 *      list compares each stored URL against to show the "URL is stale
 *      (host X ≠ current Y)" warning badge. Persisting (rather than
 *      auto-refreshing on every list load) keeps a rotation a PO event,
 *      not a background write.
 *
 * One audit row is written per CHANGED row (client-scoped, the repo
 * convention) with action "refresh_webhookEndpoint"; an idempotent run
 * (0 changes) writes none. A loopback host is accepted but flagged in the
 * response (`loopback: true`) — the UI banners it, since an external
 * provider can't reach loopback (the D-13a failure mode).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate } from "@/lib/api-utils";
import { refreshWebhookUrlsToHost, isLoopbackBase } from "@/lib/integrations";
import { auditAction } from "@/lib/security";

export async function POST(req: NextRequest) {
  const g = await gate("admin_integrations");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const b = await req.json().catch(() => ({}));
  const raw = typeof b.host === "string" ? b.host.trim() : "";
  if (!raw) return NextResponse.json({ error: "'host' required (the current live subdomain)" }, { status: 400 });

  // The host is a base (scheme://host[:port]) — never carries the webhook
  // path. Trim trailing slashes so the comparison/rewrite is canonical.
  const host = raw.replace(/\/+$/, "");
  // A value that isn't even a URL-shaped base would silently no-op the
  // rewrite — reject it up front rather than claim success.
  let parsed: URL;
  try {
    parsed = new URL(host);
  } catch {
    return NextResponse.json({ error: "'host' must be an absolute base URL (scheme://host[:port])" }, { status: 400 });
  }
  const loopback = isLoopbackBase(host);

  // 1. Rewrite the host on every ACTIVE row (idempotent; secrets untouched).
  const res = await refreshWebhookUrlsToHost(prisma, host);

  // 2. One audit row per CHANGED row, client-scoped (the repo convention).
  //    An idempotent run (updated=0) writes no rows — "nothing changed".
  for (const row of res.rows.filter((r) => r.changed)) {
    await auditAction(s, row.clientId, "refresh_webhookEndpoint", "webhookEndpoint", row.id, {
      label: row.label,
      platform: row.platform,
      from: row.before,
      to: row.after,
    });
  }

  // 3. Persist the live host as the known source the list route's stale
  //    badge compares against. Workspace-scoped: a multi-workspace setup
  //    never leaks one workspace's host into another's stored URLs.
  await prisma.workspace.update({ where: { id: s.workspaceId }, data: { liveHost: host } });

  return NextResponse.json({
    ...res,
    loopback,
    // Tells the panel whether the PO should update .env too (the GENERATION
    // base) to match the live host they just refreshed to.
    liveHost: host,
  });
}
