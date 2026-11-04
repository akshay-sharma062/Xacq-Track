/**
 * Meta CAPI (spec 5.8 / G8).
 *   GET  /api/capi          -> per-event send status + Event Match Quality
 *   POST /api/capi          -> run the send/retry queue for a client
 *
 * G8 send mode (per-client pixel mapping, PRD §5.8): with META_ACCESS_TOKEN
 * AND a configured pixel it POSTs to Meta's Conversions API (EMQ + the
 * returned event id are read back); when the token or pixel is absent it
 * simulates (marks sent locally) so the demo + tests run offline. The pixel
 * comes from .env `META_PIXEL_ID_<clientId>` (D-07), falling back to the
 * client row's `metaPixelId` (the settings-page path). The two hard rules
 * are enforced in the send module: never send twice, never send Purchase for
 * a refund.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, resolveClient } from "@/lib/api-utils";
import { capiStatus, sendQueue } from "@/lib/meta/capi";
import { pixelForClient } from "@/lib/meta/pixel-map";
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
  // G8: .env pixel mapping (D-07) wins; the client row's metaPixelId is the
  // settings-page fallback. Both absent -> simulate mode (never a fake
  // live-success).
  const out = await sendQueue(prisma, clientId, {
    metaAccessToken: process.env.META_ACCESS_TOKEN ?? "",
    metaPixelId: pixelForClient(clientId) ?? client?.metaPixelId ?? null,
  });
  return NextResponse.json(out);
}
