/**
 * D-13 — soft-revoke a webhook CONNECTION (admin-only). Sets active=false,
 * never deletes: the connection log stays intact (the audit trail) and the
 * inboundUrl simply stops verifying (a revoked conn is an "unknown
 * connection" -> the route 404s it, it is not a 500). Idempotent: revoking
 * an already-revoked row returns revoked:false, not an error.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate } from "@/lib/api-utils";
import { revokeWebhookEndpoint } from "@/lib/integrations";
import { auditAction } from "@/lib/security";

export async function POST(req: NextRequest) {
  const g = await gate("admin_integrations");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const b = await req.json().catch(() => ({}));
  const id = typeof b.id === "string" ? b.id : "";
  if (!id) return NextResponse.json({ error: "'id' required" }, { status: 400 });

  const ep = await prisma.webhookEndpoint.findUnique({ where: { id }, select: { id: true, clientId: true, platform: true, label: true, active: true } });
  if (!ep) return NextResponse.json({ error: "unknown connection" }, { status: 404 });

  const res = await revokeWebhookEndpoint(prisma, id);
  await auditAction(s, ep.clientId, "revoke", "webhookEndpoint", ep.id, { platform: ep.platform, label: ep.label, idempotent: !res.revoked });
  // Soft revoke: active=false, the connection log + row stay intact.
  return NextResponse.json({ id, revoked: res.revoked, alreadyRevoked: !ep.active });
}
