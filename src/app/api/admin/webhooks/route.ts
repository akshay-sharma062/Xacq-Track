/**
 * D-13 — webhook CONNECTION management (admin-only). Multiple connections per
 * client×platform: each row (WebhookEndpoint) has its OWN generated secret and
 * its own inboundUrl (…&conn=<id>).
 *
 *   GET  /api/admin/webhooks?client=&platform= -> list the connection rows
 *          (id, platform, label, inboundUrl, active, lastReceivedAt) — the
 *          endpointSecret is NEVER in the list response (show-once only).
 *   POST /api/admin/webhooks  { clientId, platform, label } -> create; returns
 *          { inboundUrl, secret (PLAIN, exactly once) }. The secret is
 *          reversible-stored (KMS at G10) so HMAC gateways can verify — "shown
 *          once" is an API/UI guarantee, not a storage one.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate, resolveClientSet } from "@/lib/api-utils";
import { createWebhookEndpoint, isPlatform } from "@/lib/integrations";
import { auditAction } from "@/lib/security";

export async function GET(req: NextRequest) {
  const g = await gate("admin_integrations");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const clientParam = req.nextUrl.searchParams.get("client") ?? "all";
  const clientSet = await resolveClientSet(s, clientParam);
  if (clientSet.length === 0) return NextResponse.json({ error: "no visible client" }, { status: 403 });

  const platformParam = req.nextUrl.searchParams.get("platform");
  const rows = await prisma.webhookEndpoint.findMany({
    where: {
      clientId: { in: clientSet },
      ...(platformParam && isPlatform(platformParam) ? { platform: platformParam } : {}),
    },
    // endpointSecret deliberately NOT selected — the list never exposes it.
    select: { id: true, clientId: true, platform: true, label: true, inboundUrl: true, active: true, createdAt: true, lastReceivedAt: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ clientSet, webhooks: rows });
}

export async function POST(req: NextRequest) {
  const g = await gate("admin_integrations");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const b = await req.json().catch(() => ({}));
  const clientId = typeof b.clientId === "string" ? b.clientId : "";
  const platform = b.platform;
  const label = typeof b.label === "string" ? b.label.trim() : "";
  if (!clientId || !label || !isPlatform(platform)) {
    return NextResponse.json(
      { error: "'clientId' + 'platform' (an adapter key) + 'label' required" },
      { status: 400 }
    );
  }
  const set = await resolveClientSet(s, clientId);
  if (!set.includes(clientId)) return NextResponse.json({ error: "client not visible" }, { status: 403 });

  let created;
  try {
    created = await createWebhookEndpoint(prisma, {
      clientId,
      platform,
      label,
      createdBy: s.userId,
      // The base URL the inboundUrl is built from: the app's public base if
      // configured, else localhost (dev). The PO swaps to the Vercel domain at G10.
      baseUrl: process.env.NEXT_PUBLIC_BASE_URL || undefined,
    });
  } catch (e: any) {
    // The (clientId, platform, label) unique constraint: duplicate label.
    if (e?.code === "P2002") {
      return NextResponse.json({ error: `a connection '${label}' already exists for ${platform} on this client` }, { status: 409 });
    }
    throw e;
  }

  await auditAction(s, clientId, "create", "webhookEndpoint", created.id, { platform, label });

  // The plain secret is returned EXACTLY ONCE (this body). Never in GET.
  return NextResponse.json({
    ...created,
    showOnce: true,
    warning: "Copy this webhook secret now — it is shown this one time only and cannot be retrieved later.",
  });
}
