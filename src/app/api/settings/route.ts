/**
 * Client settings (spec 5.10 / 7): attribution model + window, webhook secret
 * rotation, and CAPI pixel. Admin/owner only. Every change is audit-logged.
 *   GET  /api/settings?client=  -> current settings
 *   PATCH /api/settings          -> update { model, windowDays, webhookSecret, metaPixelId }
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, resolveClient } from "@/lib/api-utils";
import { can } from "@/lib/session";
import { auditAction } from "@/lib/security";

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clientId = await resolveClient(s, req.nextUrl.searchParams.get("client"));
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    clientId,
    name: client.name,
    attributionModel: client.attributionModel,
    attributionWindowDays: client.attributionWindowDays,
    currency: client.currency,
    timezone: client.timezone,
    offerPrice: client.offerPrice,
    metaPixelId: client.metaPixelId,
    webhookSecret: client.webhookSecret,
  });
}

export async function PATCH(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(s, "edit_settings")) return NextResponse.json({ error: "forbidden: edit_settings" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const clientId = await resolveClient(s, b.clientId);
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });

  const data: Record<string, unknown> = {};
  if (typeof b.model === "string") data.attributionModel = b.model;
  if (typeof b.windowDays === "number") data.attributionWindowDays = b.windowDays;
  if (typeof b.webhookSecret === "string") data.webhookSecret = b.webhookSecret;
  if (typeof b.metaPixelId === "string") data.metaPixelId = b.metaPixelId;

  const client = await prisma.client.update({ where: { id: clientId }, data });
  await auditAction(s, clientId, "update", "client", clientId, { fields: Object.keys(data) });
  return NextResponse.json({ ok: true, id: client.id });
}
