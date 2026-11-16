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
// D-18: which platforms run unsigned (can't send a secret header) — drives
// the per-row "clear secret" affordance + the "plain webhook (no secret)" note.
import { isUnsignedOnly, UNSIGNED_ONLY } from "@/lib/adapters";

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

  // D-18: a per-row `hasSecret` boolean (NOT the secret value — the D-13
  // show-once contract: the list never exposes it). The panel uses it to
  // offer "clear secret" only on UNSIGNED_ONLY rows that still carry a
  // leftover (pre-D-18) secret. A raw query so the value itself is never
  // selected.
  const idSet = rows.map((r) => r.id);
  // Guard the empty-set case (`IN ()` is invalid SQL): no rows → no secrets.
  const withSecret = new Set(
    idSet.length
      ? await prisma.$queryRawUnsafe<string[]>(
          `SELECT id FROM "WebhookEndpoint" WHERE id IN (${idSet.map(() => "?").join(",")}) AND "endpointSecret" != ''`,
          ...idSet
        )
      : []
  );
  const webhooks = rows.map((r) => {
    const storedHost = urlHost(r.inboundUrl);
    const stale = Boolean(currentHost && storedHost && storedHost !== currentHost && r.active);
    return {
      ...r,
      stale,
      storedHost,
      staleHost: stale ? storedHost : undefined,
      // D-18: can this platform run unsigned + does it carry a leftover secret?
      unsignedPlatform: isUnsignedOnly(r.platform),
      hasSecret: withSecret.has(r.id),
    };
  });

  return NextResponse.json({
    clientSet,
    webhooks,
    // D-15: the known-source current host + which source supplied it (the
    // panel auto-suggests the "current live host" input from this).
    currentBase: current.base,
    currentHost: currentHost ?? null,
    currentBaseSource: current.source,
    // D-18: the UNSIGNED_ONLY capability set (the panel shows the "no
    // secret" note for these platforms; a single source of truth).
    unsignedOnly: [...UNSIGNED_ONLY],
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

  // D-18: header-less platforms (flexifunnels/cosmofeed/tagmango — the
  // UNSIGNED_ONLY capability) get an EMPTY secret: the provider can't send a
  // secret header, so verify() runs unsigned (plain POST accepted, bounded
  // by per-conn rate limit + client-id + gateway-txn dedup). Surface that so
  // the PO stops expecting a secret to paste. Signed platforms keep the
  // show-once secret (unchanged).
  if (created.unsigned) {
    return NextResponse.json({
      ...created,
      showOnce: false,
      note: "Plain webhook (no secret) — this platform can't send one. Paste only the inboundUrl below; every real POST is accepted unsigned (rate-limited + deduped by gateway txn).",
    });
  }

  // The plain secret is returned EXACTLY ONCE (this body). Never in GET.
  return NextResponse.json({
    ...created,
    showOnce: true,
    warning: "Copy this webhook secret now — it is shown this one time only and cannot be retrieved later.",
  });
}
