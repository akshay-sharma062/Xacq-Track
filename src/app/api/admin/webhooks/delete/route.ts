/**
 * D-15 — HARD-delete a webhook CONNECTION (admin-only). D-13's soft revoke
 * (active=false, row + log intact) was PO-superseded ("revoke karne par
 * delete hi ho jaye"): this deletes the row for real.
 *
 *   - WebhookConnectionLog.endpoint is `onDelete: Cascade` in the schema, so
 *     the connection-level connLogs go with the row (they are THIS
 *     connection's trail).
 *   - The RAW-received-payload WebhookLog rows are client-scoped audit of
 *     what actually arrived and carry no endpoint relation — they are NOT
 *     deleted here. A heavier "also purge this client's raw webhook logs"
 *     would be a separate, explicit PO decision (recorded, not folded in).
 *   - An AuditLog row is written BEFORE the delete (actor + target endpoint
 *     id/platform/label, action "delete_webhookEndpoint"), so the audit
 *     trail outlives the row. The audit details carry platform + label only —
 *     the per-connection secret is never logged, and this file never reads
 *     or names it (the delete is a bare row + cascade; no secret handling).
 *   - Idempotency-by-404: an unknown id is a clean 404 "unknown connection",
 *     never a 500; deleting an already-deleted id 404s again (it's gone).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate } from "@/lib/api-utils";
import { deleteWebhookEndpoint } from "@/lib/integrations";
import { auditAction } from "@/lib/security";

export async function POST(req: NextRequest) {
  const g = await gate("admin_integrations");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const b = await req.json().catch(() => ({}));
  const id = typeof b.id === "string" ? b.id : "";
  if (!id) return NextResponse.json({ error: "'id' required" }, { status: 400 });

  const ep = await prisma.webhookEndpoint.findUnique({
    where: { id },
    select: { id: true, clientId: true, platform: true, label: true, active: true },
  });
  // Unknown (or already-deleted) id -> clean 404, never a 500.
  if (!ep) return NextResponse.json({ error: "unknown connection" }, { status: 404 });

  // AUDIT BEFORE the delete: the trail row must outlive the row it tracks.
  // Details carry platform + label only — the per-connection secret is never
  // read, logged, or named anywhere in this file.
  await auditAction(s, ep.clientId, "delete_webhookEndpoint", "webhookEndpoint", ep.id, {
    platform: ep.platform,
    label: ep.label,
  });

  const res = await deleteWebhookEndpoint(prisma, id);
  return NextResponse.json({
    id,
    deleted: res.deleted,
    // Explicit about what went and what stayed, so the caller (and the audit
    // trail) reconcile: connLogs cascaded with the row; raw WebhookLog rows
    // are preserved (client-scoped received-payload audit).
    cascaded: "connLogs",
    preserved: "raw WebhookLog rows",
  });
}
