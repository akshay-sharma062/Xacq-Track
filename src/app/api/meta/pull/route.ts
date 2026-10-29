/**
 * Meta Marketing API pull (spec 5.7).
 *   POST /api/meta/pull  { client, adAccount, simulate? }
 *
 * With a Meta token + ad account it does the real scheduled pull
 * (campaigns → ad sets → ads → daily insights, stored in native + INR via the
 * daily FX rate). `simulate: true` (or no token) runs the deterministic fixture
 * so the "Meta Ads pull status" screen + reports work with zero network.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, resolveClient } from "@/lib/api-utils";
import { pullAdAccount, simulatePull, upsertPulled, PulledAd } from "@/lib/meta/pull";
import { can } from "@/lib/session";

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(s, "pull_meta")) return NextResponse.json({ error: "forbidden: pull_meta" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const clientId = await resolveClient(s, b.clientId);
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });

  const token = process.env.META_ACCESS_TOKEN ?? "";

  if (!b.simulate && token && b.adAccount) {
    // Real pull against the Marketing API (spec 5.7).
    const result = await pullAdAccount(prisma, clientId, token, String(b.adAccount));
    return NextResponse.json(result);
  }

  // Simulated / offline pull: deterministic fixture ad tree.
  const account = await prisma.adAccount.findFirst({ where: { clientId } });
  const metaId = b.adAccount ?? account?.metaId ?? "sim_account";
  const name = b.adAccountName ?? account?.name ?? "Simulated Ad Account";
  const ads = simulatePull(metaId, name) as unknown as PulledAd[];
  const result = await upsertPulled(prisma, clientId, metaId, name, "USD", ads, 84);
  return NextResponse.json({ ...result, simulated: true });
}
