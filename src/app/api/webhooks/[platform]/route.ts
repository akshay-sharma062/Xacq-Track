/**
 * One inbound webhook URL per client per platform (spec 5.6):
 *   POST /api/webhooks/<platform>?client=<clientId>[&conn=<endpointId>]
 *
 * Every inbound: 1) rate-limit (spec 10), 2) verify signature / shared
 * secret via the platform adapter (spec 10), 3) run the single ingest
 * pipeline (spec architecture: "4 sources in, 3 outputs"), 4) log the webhook
 * with status + retry pointer (spec 5.6). Meta leadgen additionally does the
 * GET `hub.challenge` handshake.
 *
 * D-13: an OPTIONAL `&conn=<endpointId>` selects a per-CONNECTION inbound URL
 * (the one the PO pasted into the provider dashboard). When present, the HMAC
 * is verified against THAT WebhookEndpoint's own secret — NOT the legacy
 * Client.webhookSecret — so multiple connections on the same client×platform
 * (two FlexiFunnels accounts, two Razorpay test+prod, …) verify
 * independently. When absent, the route behaves exactly as today (the legacy
 * single Client.webhookSecret path; G4/D-06 behaviour is unchanged). A
 * bad/revoked `conn` id is a 404 "unknown connection", never a 500. Each
 * received conn event also records one WebhookConnectionLog row (payload hash
 * only — the raw payload still goes to the existing WebhookLog).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ADAPTERS } from "@/lib/adapters";
import { SourcePlatform } from "@/lib/types";
import { processInbound } from "@/lib/ingest";
import { rateLimit } from "@/lib/security";
import { mapConnStatus, recordConnectionLog, resolveEndpointForRoute, sha256Hex } from "@/lib/integrations";

const PLATFORMS = Object.keys(ADAPTERS) as SourcePlatform[];

export async function GET(req: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  // Meta leadgen webhook verification handshake (spec 5.2 / section D).
  if (req.nextUrl.searchParams.get("hub.mode") === "subscribe") {
    const token = process.env.META_LEADGEN_WEBHOOK_VERIFY_TOKEN ?? "";
    const provided = req.nextUrl.searchParams.get("hub.verify_token");
    if (token && provided === token) {
      return new NextResponse(req.nextUrl.searchParams.get("hub.challenge") ?? "");
    }
    return NextResponse.json({ error: "verification failed" }, { status: 403 });
  }
  // Anything else on GET is the "ping" some platforms send; acknowledge.
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform: platformRaw } = await params;
  const platform = platformRaw as SourcePlatform;
  if (!PLATFORMS.includes(platform)) {
    return NextResponse.json({ error: `unknown platform '${platform}'` }, { status: 404 });
  }

  const clientParam = req.nextUrl.searchParams.get("client");
  if (!clientParam) {
    return NextResponse.json({ error: "?client=<clientId> required" }, { status: 400 });
  }
  const client = await prisma.client.findUnique({ where: { id: clientParam } });
  if (!client) return NextResponse.json({ error: "unknown client" }, { status: 404 });

  // D-13: the optional per-CONNECTION selection. When `conn` is present, the
  // verify secret comes from that WebhookEndpoint row (active, same client +
  // platform), NOT the legacy single Client.webhookSecret. Absent => the
  // legacy path below is unchanged.
  const connParam = req.nextUrl.searchParams.get("conn");
  let connEndpoint: import("@prisma/client").WebhookEndpoint | null = null;
  if (connParam) {
    connEndpoint = await resolveEndpointForRoute(prisma, connParam, client.id, platform);
    if (!connEndpoint) {
      // Bad id, revoked (active=false), or a conn that belongs to a different
      // client/platform: a clean 404, never a 500, never a silent fallback to
      // the legacy secret (that would verify against the WRONG secret).
      return NextResponse.json({ error: "unknown connection" }, { status: 404 });
    }
  }

  // Rate limit per client+platform+connection (spec 10). conn-scoped so two
  // connections on the same client×platform can't starve each other.
  const rl = rateLimit(`wh:${client.id}:${platform}:${connParam ?? "legacy"}`);
  if (!rl.ok) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  headers.rawBody = rawBody;

  // D-13: the verifying secret is the connection's own when conn is present
  // (reversible-stored — see src/lib/integrations.ts), else the legacy
  // Client.webhookSecret (G4/D-06 path, byte-for-byte unchanged behaviour).
  const secret = connEndpoint ? connEndpoint.endpointSecret : client.webhookSecret;

  const res = await processInbound({
    prisma,
    clientId: client.id,
    platform,
    clientSecret: secret,
    rawBody,
    headers,
  });

  // D-13: one connection-log row per received event (payload hash, not the
  // raw body) + a fresh lastReceivedAt on the endpoint.
  if (connEndpoint) {
    await recordConnectionLog(prisma, connEndpoint.id, {
      status: mapConnStatus(res.status),
      error: res.error ?? null,
      payloadHash: sha256Hex(rawBody),
    });
    await prisma.webhookEndpoint.update({
      where: { id: connEndpoint.id },
      data: { lastReceivedAt: new Date() },
    });
  }

  // 2xx so the upstream retries only on real failures (spec: land within 1 min).
  if (res.status === "failed") {
    return NextResponse.json({ accepted: false, webhookLogId: res.webhookLogId, connection: Boolean(connEndpoint), error: res.error }, { status: 502 });
  }
  return NextResponse.json({
    accepted: true,
    webhookLogId: res.webhookLogId,
    connection: Boolean(connEndpoint),
    status: res.status,
    events: res.events,
    payments: res.payments,
    capiQueued: res.capiQueued,
    leadIds: res.leadIds,
  });
}
