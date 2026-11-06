/**
 * D-13 — revoke an API key (admin-only). Idempotent: revoking an already
 * revoked (or unknown) key returns revoked:false, never an error. The plain
 * key was never stored, so revoke = stamping revokedAt (the row + hash stay
 * intact — a revoked key still fails keyMatchesHash lookups, which is the
 * point: nothing is deleted, nothing is retrievable).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { gate } from "@/lib/api-utils";
import { revokeApiKey } from "@/lib/integrations";
import { auditAction } from "@/lib/security";

export async function POST(req: NextRequest) {
  const g = await gate("admin_integrations");
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const s = g.session;

  const b = await req.json().catch(() => ({}));
  const id = typeof b.id === "string" ? b.id : "";
  if (!id) return NextResponse.json({ error: "'id' required" }, { status: 400 });

  const key = await prisma.apiKey.findUnique({ where: { id }, select: { id: true, clientId: true, label: true, revokedAt: true } });
  if (!key) return NextResponse.json({ error: "unknown key" }, { status: 404 });

  const res = await revokeApiKey(prisma, id);
  if (key.clientId) {
    await auditAction(s, key.clientId, "revoke", "apiKey", key.id, { label: key.label, idempotent: !res.revoked });
  }
  return NextResponse.json({ id, revoked: res.revoked, alreadyRevoked: Boolean(key.revokedAt) });
}
