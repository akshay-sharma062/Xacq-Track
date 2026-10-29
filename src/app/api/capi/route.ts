/**
 * Meta CAPI (spec 5.8).
 *   GET  /api/capi          -> per-event send status + Event Match Quality
 *   POST /api/capi/send     -> run the send/retry queue for a client
 *
 * Send mode: with META_ACCESS_TOKEN it POSTs to Meta's Conversions API; without
 * a token it simulates (marks sent locally) so the demo + tests run offline.
 * The two hard rules are enforced in the send module: never send twice, never
 * send Purchase for a refund.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, resolveClient } from "@/lib/api-utils";
import { capiStatus, sendQueue } from "@/lib/meta/capi";
import { can } from "@/lib/session";

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clientId = await resolveClient(s, req.nextUrl.searchParams.get("client"));
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });
  const data = await capiStatus(prisma, clientId);
  return NextResponse.json({ clientId, ...data });
}

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(s, "send_capi")) return NextResponse.json({ error: "forbidden: send_capi" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const clientId = await resolveClient(s, b.clientId);
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const out = await sendQueue(prisma, clientId, {
    metaAccessToken: process.env.META_ACCESS_TOKEN ?? "",
    metaPixelId: client?.metaPixelId,
  });
  return NextResponse.json(out);
}
