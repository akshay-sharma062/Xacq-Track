/**
 * Session bootstrap (spec 5.10: our roles + the client portal).
 *
 *   GET  /api/session            -> the acting user (role, visible clients,
 *        phone-mask state), the demo personas to switch between, and the
 *        visible client list (drives the topbar client switcher).
 *   POST /api/session            -> { email }  sets the xacqora_user cookie,
 *        switching which persona the app acts as. (Local-demo stand-in for
 *        Supabase Auth; the `Session` shape stays identical when it's swapped.)
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/api-utils";
import { ROLES, visibleClients } from "@/lib/session";

export async function GET() {
  const s = await getSession();
  const visible = s ? await visibleClients(s) : [];

  // Visible client names for the topbar switcher.
  const clients = visible.length
    ? await prisma.client.findMany({ where: { id: { in: visible } }, select: { id: true, name: true } })
    : [];

  // D-01: the ad-account filter options, driven by the AdAccount link rows
  // (one Meta account today: Upcurvv-FML). Real DB data, not a canned list.
  const adAccounts = visible.length
    ? await prisma.adAccount.findMany({
        where: { clientId: { in: visible } },
        select: { metaId: true, name: true, displayOwnerName: true, currency: true, status: true, clientId: true },
        orderBy: { name: "asc" },
      })
    : [];

  // Demo personas = users in the same workspace as the acting user (or all
  // users when unauthenticated, so the switcher always has options).
  const users = await prisma.user.findMany({
    where: s ? { workspaceId: s.workspaceId } : {},
    select: { email: true, name: true, role: true, phoneMask: true },
    orderBy: { role: "asc" },
  });

  return NextResponse.json({
    session: s
      ? { email: s.email, name: s.name, role: s.role, maskPhone: s.maskPhone, clientIds: visible }
      : null,
    clients,
    adAccounts,
    personas: users,
    roles: ROLES,
  });
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const email = String(b.email ?? "").trim();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  const user = await prisma.user.findFirst({ where: { email } });
  if (!user) return NextResponse.json({ error: "unknown user" }, { status: 404 });

  const res = NextResponse.json({ ok: true, email });
  res.cookies.set("xacqora_user", email, {
    httpOnly: false,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return res;
}
