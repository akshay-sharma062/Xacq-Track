/**
 * Duplicate review list (spec 5.3): likely duplicates for a human to merge.
 *   GET /api/duplicates?client=  -> same-client leads that share an email but
 *       disagree on phone, or are explicitly flagged.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession, resolveClient } from "@/lib/api-utils";
import { duplicateCandidates } from "@/lib/leads";

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clientId = await resolveClient(s, req.nextUrl.searchParams.get("client"));
  const rows = await duplicateCandidates(clientId ?? undefined);
  return NextResponse.json({ duplicates: rows, count: rows.length });
}
