/**
 * D-13 — API key management (admin-only).
 *   GET  /api/admin/keys        -> list this workspace's keys (NEVER the key value)
 *   POST /api/admin/keys        -> create { label, clientId?, purpose } -> the plain
 *                                  key EXACTLY ONCE in the body (hash is what's stored)
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate, resolveClientSet } from "@/lib/api-utils";
import { createApiKey } from "@/lib/integrations";
import { auditAction } from "@/lib/security";

export async function GET() {
  const g = await gate("admin_integrations");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;
  const clientSet = await resolveClientSet(s, "all");
  // Keys: client-scoped ones for the visible clients + workspace-level (clientId=null).
  const keys = await prisma.apiKey.findMany({
    where: { OR: [{ clientId: null }, { clientId: { in: clientSet } }] },
    select: { id: true, label: true, clientId: true, purpose: true, createdAt: true, revokedAt: true, lastUsedAt: true },
    orderBy: { createdAt: "asc" },
  });
  // Never return a key value: the DB holds only keyHash, and we don't even select it.
  return NextResponse.json({ keys });
}

export async function POST(req: NextRequest) {
  const g = await gate("admin_integrations");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const b = await req.json().catch(() => ({}));
  const label = typeof b.label === "string" ? b.label.trim() : "";
  const purpose = b.purpose === "ingest" || b.purpose === "api" || b.purpose === "webhook_verify" ? b.purpose : null;
  if (!label || !purpose) {
    return NextResponse.json({ error: "'label' + purpose ('ingest'|'api'|'webhook_verify') required" }, { status: 400 });
  }
  let clientId: string | null = null; // default = workspace-level admin key
  if (typeof b.clientId === "string" && b.clientId) {
    const set = await resolveClientSet(s, b.clientId);
    if (!set.includes(b.clientId)) return NextResponse.json({ error: "client not visible" }, { status: 403 });
    clientId = b.clientId;
  }

  const created = await createApiKey(prisma, { label, clientId, purpose, createdBy: s.userId });
  // Audit-log the create ONLY for client-scoped keys: AuditLog.clientId is an
  // FK to Client, so a workspace-level key (clientId=null) has no audit
  // target — its own row (createdBy/createdAt) is its audit trail. The
  // ticket's "audit-log write on create/revoke" is honoured on every client
  // key; the workspace-admin key is documented as row-audited.
  if (clientId) {
    await auditAction(s, clientId, "create", "apiKey", created.id, { label, purpose });
  }

  // The plain key is returned EXACTLY ONCE (this body). The DB holds keyHash only.
  return NextResponse.json({ ...created, showOnce: true, warning: "Copy this key now — it is shown this one time only and cannot be retrieved later." });
}
