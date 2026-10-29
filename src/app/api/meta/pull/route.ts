/**
 * Meta Marketing API pull (spec 5.7).
 *   POST /api/meta/pull  { client, adAccount?, adAccounts?, days?, simulate? }
 *
 * Gate order (G1 contract):
 *   1. `simulate: true` OR `META_SIMULATE=1` OR no token  → deterministic
 *      fixture via `simulatePull` (zero-network demo / fallback).
 *   2. token + ad account(s)  → the REAL Marketing API pull: campaigns → ad
 *      sets → creatives → DAILY insights, spend stored in billing currency
 *      AND INR via the stored daily FX rate (fx-store). One account's failure
 *      is recorded, not fatal to the others.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, resolveClient } from "@/lib/api-utils";
import {
  pullAdAccount,
  pullAllAccounts,
  simulatePull,
  upsertPulled,
  isSimulateMode,
  PulledAd,
} from "@/lib/meta/pull";
import { resolveDayRates } from "@/lib/fx-store";
import { can } from "@/lib/session";

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(s, "pull_meta")) return NextResponse.json({ error: "forbidden: pull_meta" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const clientId = await resolveClient(s, b.clientId);
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });

  const token = process.env.META_ACCESS_TOKEN ?? "";
  const days = Number(b.days) > 0 ? Math.min(Number(b.days), 30) : 7;
  const forceSimulate = b.simulate === true || isSimulateMode();

  if (!forceSimulate && token) {
    const accounts: string[] = Array.isArray(b.adAccounts) && b.adAccounts.length
      ? b.adAccounts.map(String)
      : b.adAccount
        ? [String(b.adAccount)]
        : [];
    if (accounts.length > 0) {
      // Real pull; multiple accounts isolated so one failure doesn't kill the rest.
      const { results, failures } = await pullAllAccounts(prisma, clientId, token, accounts, undefined, days);
      return NextResponse.json({ simulated: false, days, results, failures });
    }
    // No account specified: fall through to the client's stored ad account.
    const stored = await prisma.adAccount.findFirst({ where: { clientId } });
    if (stored) {
      const { results, failures } = await pullAllAccounts(prisma, clientId, token, [stored.metaId], undefined, days);
      return NextResponse.json({ simulated: false, days, results, failures });
    }
  }

  // Simulated / offline pull: deterministic fixture ad tree, multi-day series.
  const account = await prisma.adAccount.findFirst({ where: { clientId } });
  const metaId = b.adAccount ?? account?.metaId ?? "sim_account";
  const name = b.adAccountName ?? account?.name ?? "Simulated Ad Account";
  const ads = simulatePull(metaId, name, days) as PulledAd[];
  const dayList = [...new Set(ads.map((a) => a.day))];
  const { byDay: fxRates, liveFills } = await resolveDayRates(prisma, "USD", dayList);
  const result = await upsertPulled(prisma, clientId, metaId, name, "USD", ads, fxRates, liveFills, true);
  return NextResponse.json({ simulated: true, days, results: [result], failures: [] });
}
