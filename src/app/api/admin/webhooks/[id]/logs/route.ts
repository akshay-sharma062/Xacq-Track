/**
 * D-13 — the last 100 WebhookConnectionLog rows for one webhook CONNECTION
 * (admin-only). Returns the SHA-256 payloadHash per event (dedup/audit),
 * status + error + receivedAt — NEVER the raw payload (that stays in the
 * existing WebhookLog table, which is what the retry/re-process path reads).
 * The endpoint must belong to a client the caller can see; an unknown id is
 * 404, not 500.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate, resolveClientSet } from "@/lib/api-utils";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate("admin_integrations");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const { id } = await params;
  const ep = await prisma.webhookEndpoint.findUnique({ where: { id }, select: { id: true, clientId: true, platform: true, label: true, active: true } });
  if (!ep) return NextResponse.json({ error: "unknown connection" }, { status: 404 });

  // Client-scoped: the connection's client must be visible to this session.
  const set = await resolveClientSet(s, ep.clientId);
  if (!set.includes(ep.clientId)) return NextResponse.json({ error: "client not visible" }, { status: 403 });

  const logs = await prisma.webhookConnectionLog.findMany({
    where: { endpointId: ep.id },
    orderBy: { receivedAt: "desc" },
    take: 100,
    select: { id: true, receivedAt: true, status: true, error: true, payloadHash: true },
  });
  return NextResponse.json({
    endpoint: { id: ep.id, platform: ep.platform, label: ep.label, active: ep.active, clientId: ep.clientId },
    count: logs.length,
    logs,
  });
}
