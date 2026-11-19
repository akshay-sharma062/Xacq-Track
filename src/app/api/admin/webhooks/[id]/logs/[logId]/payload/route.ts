/**
 * D-19 — "show payload" (admin-only, PII-masked by role): the stored raw body
 * for ONE connection-log row. The raw payload already lives on
 * `WebhookLog.rawPayload` (spec 4: keep raw of every incoming webhook); this
 * route links a `WebhookConnectionLog` row to it via its `payloadHash` and
 * returns the parsed + (for masked roles) last-4-reduced structure.
 *
 * Gating + scoping mirror the sibling /logs route: `admin_integrations`
 * (owner/admin only), the connection's client must be visible to the caller,
 * the log id must belong to THIS endpoint (no cross-connection read), and an
 * unknown id is a clean 404, never a 500. Masking follows session.maskPhone:
 * owner/admin (maskPhone=false) see the full value; a masked role sees
 * phone/email reduced to •••• + last-4 (spec 5.10).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate, resolveClientSet } from "@/lib/api-utils";
import { maskWebhookPayload, findWebhookLogForConn } from "@/lib/webhookPayload";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; logId: string }> }
) {
  const g = await gate("admin_integrations");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const { id, logId } = await params;
  const ep = await prisma.webhookEndpoint.findUnique({
    where: { id },
    select: { id: true, clientId: true, platform: true },
  });
  if (!ep) return NextResponse.json({ error: "unknown connection" }, { status: 404 });

  const set = await resolveClientSet(s, ep.clientId);
  if (!set.includes(ep.clientId)) {
    return NextResponse.json({ error: "client not visible" }, { status: 403 });
  }

  // The log must belong to THIS endpoint (a conn log id from another
  // connection must not resolve — no cross-connection payload read).
  const log = await prisma.webhookConnectionLog.findUnique({ where: { id: logId } });
  if (!log || log.endpointId !== ep.id) {
    return NextResponse.json({ error: "unknown connection log" }, { status: 404 });
  }

  // Link to the raw body via the payload hash (the designed link — the conn
  // log stores only the hash; the raw body stays on the WebhookLog row).
  const raw = await findWebhookLogForConn(prisma, ep.clientId, ep.platform, log.payloadHash);
  if (raw == null) {
    // No recent WebhookLog row hashes to this value (purged, or a legacy
    // pre-hash row). Report it, never invent a payload.
    return NextResponse.json({
      log: { id: logId, receivedAt: log.receivedAt.toISOString(), status: log.status },
      found: false,
      note: "raw payload not retained for this event (no matching WebhookLog row).",
    });
  }

  const { payload, masked } = maskWebhookPayload(raw, s);
  return NextResponse.json({
    log: { id: logId, receivedAt: log.receivedAt.toISOString(), status: log.status, error: log.error },
    found: true,
    masked,
    payload,
  });
}
