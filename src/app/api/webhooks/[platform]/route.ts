/**
 * One inbound webhook URL per client per platform (spec 5.6):
 *   POST /api/webhooks/<platform>?client=<clientId>
 *
 * Every inbound: 1) rate-limit (spec 10), 2) verify signature / shared
 * secret via the platform adapter (spec 10), 3) run the single ingest
 * pipeline (spec architecture: "4 sources in, 3 outputs"), 4) log the webhook
 * with status + retry pointer (spec 5.6). Meta leadgen additionally does the
 * GET `hub.challenge` handshake.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ADAPTERS } from "@/lib/adapters";
import { SourcePlatform } from "@/lib/types";
import { processInbound } from "@/lib/ingest";
import { rateLimit } from "@/lib/security";

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

  // Rate limit the public ingest API per client+platform (spec 10).
  const rl = rateLimit(`wh:${client.id}:${platform}`);
  if (!rl.ok) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  headers.rawBody = rawBody;

  const res = await processInbound({
    prisma,
    clientId: client.id,
    platform,
    clientSecret: client.webhookSecret,
    rawBody,
    headers,
  });

  // 2xx so the upstream retries only on real failures (spec: land within 1 min).
  if (res.status === "failed") {
    return NextResponse.json({ accepted: false, webhookLogId: res.webhookLogId, error: res.error }, { status: 502 });
  }
  return NextResponse.json({
    accepted: true,
    webhookLogId: res.webhookLogId,
    status: res.status,
    events: res.events,
    payments: res.payments,
    capiQueued: res.capiQueued,
    leadIds: res.leadIds,
  });
}
