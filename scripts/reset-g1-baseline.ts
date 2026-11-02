/**
 * One-time dev.db reset to the clean D-02 baseline (G1 only). The two
 * overlapping multi-account onboarding runs left: 3 suffixed-dup clients +
 * 3 orphan clean-slug clients + 2 missing link rows + double-counted G1
 * spend. This wipes every non-G1 ad-account tree + non-cl_upcurvv client and
 * restores G1 to its verified single 30-day snapshot (₹51,480.77, 39 rows),
 * so the fixed onboarding starts from a clean, reproducible state.
 *
 * Idempotent: re-running is a no-op once the baseline is reached.
 *
 * Run: `npx tsx scripts/reset-g1-baseline.ts`
 */
import { PrismaClient } from "@prisma/client";

const G1_META = "act_4749960348632164";
const G1_CLIENT = "cl_upcurvv";

async function main() {
  const p = new PrismaClient();

  // Non-G1 AdAccount link rows -> their whole ad trees.
  const foreign = await p.adAccount.findMany({
    where: { metaId: { not: G1_META } },
    select: { id: true },
  });
  for (const f of foreign) {
    const ads = (await p.ad.findMany({ where: { adAccountId: f.id }, select: { metaId: true } })).map((a) => a.metaId);
    await p.$transaction([
      p.creative.deleteMany({ where: { adMetaId: { in: ads } } }),
      p.spend.deleteMany({ where: { adAccountId: f.id } }),
      p.ad.deleteMany({ where: { adAccountId: f.id } }),
      p.adSet.deleteMany({ where: { adAccountId: f.id } }),
      p.adCampaign.deleteMany({ where: { adAccountId: f.id } }),
      p.adAccount.delete({ where: { id: f.id } }),
    ]);
  }

  // Non-G1 clients + their (empty) data rows.
  const dead = await p.client.findMany({ where: { id: { not: G1_CLIENT } }, select: { id: true } });
  for (const c of dead) {
    await p.$transaction([
      p.auditLog.deleteMany({ where: { clientId: c.id } }),
      p.outboundEvent.deleteMany({ where: { clientId: c.id } }),
      p.webhookLog.deleteMany({ where: { clientId: c.id } }),
      p.payment.deleteMany({ where: { clientId: c.id } }),
      p.event.deleteMany({ where: { clientId: c.id } }),
      p.touchpoint.deleteMany({ where: { clientId: c.id } }),
      p.lead.deleteMany({ where: { clientId: c.id } }),
      p.visitor.deleteMany({ where: { clientId: c.id } }),
      p.client.delete({ where: { id: c.id } }),
    ]);
  }

  // G1: keep the single most-recent 30-day snapshot (the no-range rollup
  // advances date_stop, so the latest day group is the current window). This
  // undoes the double-count the pre-fix re-pulls stacked.
  const g1 = await p.adAccount.findUnique({ where: { metaId: G1_META } });
  if (g1) {
    const days = await p.spend.findMany({
      where: { adAccountId: g1.id },
      select: { day: true },
      distinct: ["day"],
      orderBy: { day: "desc" },
    });
    const newest = days[0]?.day;
    if (newest) {
      // Drop every G1 spend row that is NOT the newest snapshot window.
      await p.spend.deleteMany({ where: { adAccountId: g1.id, day: { not: newest } } });
    }
  }

  // Report the clean state.
  const c = await p.client.count();
  const a = await p.adAccount.count();
  const g = await p.spend.aggregate({ where: { adAccountId: (await p.adAccount.findUnique({ where: { metaId: G1_META } }))?.id }, _sum: { inrSpend: true } });
  const rows = await p.spend.count();
  console.log(`Reset to G1 baseline: clients=${c} adAccounts=${a} totalSpendRows=${rows} G1inrSpend=₹${g._sum.inrSpend ?? 0}`);

  await p.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
