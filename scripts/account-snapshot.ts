/**
 * READ-ONLY per-account snapshot. Prints, for every AdAccount in the DB:
 *   metaId | name | currency | clientId | campaigns | adSets | ads | spendRows | inrSpend
 * plus a global model row count. No writes, no Meta calls. Run before + after an
 * onboarding pass: the two outputs must be identical to prove idempotency.
 */
import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();
  const accts = await prisma.adAccount.findMany({ orderBy: { metaId: "asc" } });
  console.log("metaId | name | currency | clientId | campaigns | adSets | ads | spendRows | inrSpend");
  for (const a of accts) {
    const c = await prisma.adCampaign.count({ where: { adAccountId: a.id } });
    const s = await prisma.adSet.count({ where: { adAccountId: a.id } });
    const ad = await prisma.ad.count({ where: { adAccountId: a.id } });
    const sp = await prisma.spend.count({ where: { adAccountId: a.id } });
    const sum = await prisma.spend.aggregate({ where: { adAccountId: a.id }, _sum: { inrSpend: true } });
    console.log(
      `${a.metaId} | ${a.name} | ${a.currency} | ${a.clientId} | ${c} | ${s} | ${ad} | ${sp} | ₹${sum._sum.inrSpend ?? 0}`
    );
  }
  const models = [
    "client",
    "adAccount",
    "adCampaign",
    "adSet",
    "ad",
    "creative",
    "spend",
    "fxRate",
  ] as const;
  const counts: string[] = [];
  for (const m of models) {
    const n = await (prisma as any)[m].count();
    counts.push(`${m}=${n}`);
  }
  console.log("GLOBAL: " + counts.join(" "));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
