/**
 * Lead list + search (spec 5.4): filter by client, funnel, stage, campaign,
 * ad, date range; search by phone/email/name. POST creates a lead manually.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, resolveClient } from "@/lib/api-utils";
import { searchLeads } from "@/lib/leads";

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const clientId = await resolveClient(s, sp.get("client"));
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });

  const rows = await searchLeads(
    {
      clientId,
      funnelId: sp.get("funnel") ?? undefined,
      stage: sp.get("stage") ?? undefined,
      campaignId: sp.get("campaign") ?? undefined,
      adId: sp.get("ad") ?? undefined,
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      q: sp.get("q") ?? undefined,
      sourceUnknown: sp.get("source") === "unknown",
      duplicate: sp.get("duplicates") === "true",
    },
    s
  );
  return NextResponse.json({ leads: rows, count: rows.length });
}

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const clientId = await resolveClient(s, b.clientId);
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });

  const lead = await prisma.lead.create({
    data: {
      clientId,
      name: b.name ?? null,
      email: b.email ?? null,
      phone: b.phone ?? null,
      city: b.city ?? null,
      stage: b.stage ?? "New",
      sourceUnknown: !b.phone && !b.email,
    },
  });
  return NextResponse.json({ id: lead.id }, { status: 201 });
}
