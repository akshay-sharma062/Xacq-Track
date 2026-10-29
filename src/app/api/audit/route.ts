/**
 * Audit log (spec 5.10 / 10): who viewed, exported or changed what.
 *   GET /api/audit?client=&action=&limit=  -> newest-first audit rows, scoped
 *       to the acting session's visible client. The log itself is append-only
 *       (only written by security.auditExport / auditAction).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, resolveClient } from "@/lib/api-utils";

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const clientId = await resolveClient(s, sp.get("client"));
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });

  const rows = await prisma.auditLog.findMany({
    where: {
      clientId,
      ...(sp.get("action") ? { action: sp.get("action")! } : {}),
    },
    include: { user: { select: { name: true, email: true, role: true } } },
    orderBy: { at: "desc" },
    take: Math.min(Number(sp.get("limit")) || 200, 500),
  });
  return NextResponse.json({ rows, count: rows.length });
}
