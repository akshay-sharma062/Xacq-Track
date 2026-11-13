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
import { createWebhookEndpoint, isPlatform, currentWebhookHost, urlHost } from "@/lib/integrations";
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

  // D-15: the "current live host" the stored URLs should point at (the
  // PO-persisted Workspace.liveHost, else the .env base). Each row's stored
  // host is compared to it so the panel can badge a DEAD-subdomain URL
  // ("URL is stale: host X ≠ current Y") WITHOUT auto-refreshing — the PO
  // clicks "Refresh URLs" to re-point (a rotation is a PO event, not a
  // background write). The currentBase is NEVER a loopback-less fake: it's
  // exactly what currentWebhookHost resolves.
  const current = await currentWebhookHost(prisma, s.workspaceId);
  const currentHost = urlHost(current.base);
  const webhooks = rows.map((r) => {
    const storedHost = urlHost(r.inboundUrl);
    const stale = Boolean(currentHost && storedHost && storedHost !== currentHost && r.active);
    return { ...r, stale, storedHost, staleHost: stale ? storedHost : undefined };
  });

  return NextResponse.json({
    clientSet,
    webhooks,
    // D-15: the known-source current host + which source supplied it (the
    // panel auto-suggests the "current live host" input from this).
    currentBase: current.base,
    currentHost: currentHost ?? null,
    currentBaseSource: current.source,
  });
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
      // D-13a: no explicit baseUrl here — the base follows the env
      // precedence PUBLIC_BASE_URL > NEXT_PUBLIC_BASE_URL > localhost-dev
      // (resolveWebhookBase). An explicit baseUrl is a test/caller override
      // only; passing NEXT_PUBLIC_BASE_URL here would shadow PUBLIC_BASE_URL.
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
