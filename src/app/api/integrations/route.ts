/**
 * Integrations hub (spec 5.6). One inbound URL per client per platform, with a
 * shared secret; every webhook logged with status + a retry button; a test
 * button that sends a fake event and shows where it landed.
 *
 *   GET  /api/integrations?client=  -> per-platform status: sample, secret,
 *        latest webhook log rows (processed/failed/duplicate), retry target.
 *   POST /api/integrations/test     -> replay the platform's SAVED sample
 *        payload through the real pipeline and report where it landed (spec 6:
 *        "every platform has a test button that sends a fake event").
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, resolveClient, webhookStats } from "@/lib/api-utils";
import { ADAPTERS } from "@/lib/adapters";
import { processInbound } from "@/lib/ingest";
import { can } from "@/lib/session";
import { SourcePlatform } from "@/lib/types";

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clientId = await resolveClient(s, req.nextUrl.searchParams.get("client"));
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });

  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { webhookSecret: true } });
  const stats = await webhookStats(clientId);

  // Latest webhook log rows (spec 5.6: every inbound logged with status).
  const logs = await prisma.webhookLog.findMany({
    where: { clientId },
    orderBy: { receivedAt: "desc" },
    take: 100,
    select: {
      id: true, platform: true, status: true, error: true, retryCount: true,
      receivedAt: true, processedAt: true,
    },
  });

  const platforms = (Object.keys(ADAPTERS) as SourcePlatform[]).map((p) => ({
    platform: p,
    label: ADAPTERS[p].label,
    hasSignatureVerifier: Boolean(ADAPTERS[p].verify),
    sample: ADAPTERS[p].sample,
  }));

  return NextResponse.json({
    clientId,
    sharedSecret: client?.webhookSecret ?? null,
    stats,
    logs,
    platforms,
  });
}

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(s, "pull_meta")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const clientId = await resolveClient(s, b.clientId);
  const platform = b.platform as SourcePlatform;
  if (!clientId || !ADAPTERS[platform]) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  // Replay the SAVED SAMPLE (spec 8) through the real pipeline. The secret is
  // passed through so adapters that verify a shared secret succeed on their
  // own sample; the result reports exactly where the fake event landed.
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const res = await processInbound({
    prisma,
    clientId,
    platform,
    clientSecret: null, // test button: unsigned sample, so verification passes
    rawBody: JSON.stringify(ADAPTERS[platform].sample),
    headers: { "x-webhook-secret": client?.webhookSecret ?? "" },
  });
  return NextResponse.json({
    tested: platform,
    status: res.status,
    leadIds: res.leadIds,
    events: res.events,
    payments: res.payments,
    capiQueued: res.capiQueued,
    webhookLogId: res.webhookLogId,
  });
}
