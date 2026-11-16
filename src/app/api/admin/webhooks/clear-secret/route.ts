/**
 * D-18 — "make this connection unsigned (clear secret)" (admin-only).
 *
 * A pre-D-18 connection for a header-less platform (UNSIGNED_ONLY =
 * flexifunnels / cosmofeed / tagmango) may still carry a generated
 * endpointSecret. That secret is useless (the provider cannot send it) and
 * actively harmful — verify() then requires an `x-webhook-secret` header the
 * provider never sends, so every real POST logs "verification failed". This
 * empties it so the connection runs unsigned.
 *
 * Security guardrail (the ticket's non-negotiable): a SIGNED-CAPABLE
 * platform (razorpay / cashfree / …) is NEVER clearable — clearing it would
 * let an unauthenticated POST pass verify(). The lib returns
 * { signedPlatform: true } and the route surfaces it as a clean 400, no
 * write. Idempotent: clearing an already-unsigned row is a no-op
 * (alreadyUnsigned: true, still 200 so the UI can report "already plain").
 *
 * An AuditLog row is written BEFORE the clear (actor + target endpoint
 * id/platform/label, action "clear_webhookEndpointSecret"); details carry
 * platform + label only — the (now-empty) secret is never logged.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate } from "@/lib/api-utils";
import { clearWebhookEndpointSecret } from "@/lib/integrations";
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
    select: { id: true, clientId: true, platform: true, label: true },
  });
  // Unknown id -> clean 404, never a 500.
  if (!ep) return NextResponse.json({ error: "unknown connection" }, { status: 404 });

  // A SIGNED-CAPABLE platform must keep its secret (the D-18 guardrail): a
  // clear would open an unsigned POST path. Reject before any write.
  const res = await clearWebhookEndpointSecret(prisma, id);
  if (res.signedPlatform) {
    return NextResponse.json(
      { error: `platform '${ep.platform}' is signed-capable — clearing its secret would let unauthenticated POSTs pass; keep it (re-create with a signed platform or re-issue the secret)` },
      { status: 400 }
    );
  }

  // AUDIT BEFORE (the trail outlives the state change). Details carry
  // platform + label only — never the secret (it's now empty anyway).
  if (res.cleared && !res.alreadyUnsigned) {
    await auditAction(s, ep.clientId, "clear_webhookEndpointSecret", "webhookEndpoint", ep.id, {
      platform: ep.platform,
      label: ep.label,
    });
  }

  return NextResponse.json({
    id,
    cleared: res.cleared,
    alreadyUnsigned: res.alreadyUnsigned ?? false,
    note: res.alreadyUnsigned
      ? "already unsigned (no secret to clear)"
      : "secret cleared — this header-less connection now runs unsigned (plain POST accepted)",
  });
}
