/**
 * Dashboard-V2 §4 evidence runner (this machine, real FX — no hardcoded rate):
 *   1. `fetchLiveFxRate("AED")` — walk the 3-source chain, print the fetched
 *      AED→INR rate + the winning source (or the exact 3 error strings if all
 *      three are unreachable → "FX: BLOCKED: network", never a fake rate).
 *   2. `backfillMissingInr(prisma)` — re-convert the stored native-only spend
 *      rows (inrRate=0) and print the AED account's new INR total.
 * Read the dev.db; no Meta token needed. Safe to run twice (idempotent).
 */
import { PrismaClient } from "@prisma/client";
import { fetchLiveFxRate, backfillMissingInr } from "../src/lib/fx-store";

async function main() {
  const prisma = new PrismaClient();

  console.log("\n=== §4 FX live fetch (3-source chain, this machine) ===");
  const live = await fetchLiveFxRate("AED");
  if (live.rate > 0) {
    console.log(`  AED→INR fetched rate = ${live.rate}  (source: ${live.source})`);
  } else {
    console.log("  FX: BLOCKED: network — all three sources unreachable:");
    for (const e of live.errors) console.log(`    - ${e}`);
  }

  // Ensure a stored rate for the pulled day exists (fetchLiveFxRate does NOT
  // persist; ensureRate/backfill do). backfillMissingInr handles this via
  // ensureRate internally.
  const before = await prisma.spend.aggregate({
    where: { currency: "AED", inrRate: 0 },
    _count: true,
    _sum: { spend: true },
  });
  console.log(`\n  native-only AED spend rows before backfill: ${before._count} (native total ${before._sum.spend})`);

  const res = await backfillMissingInr(prisma);
  console.log(`  backfill: ${res.updatedRows} rows re-converted; rates resolved: ${res.rates.length}`);

  // The AED account's new INR total (the ticket's requested evidence).
  const aed = await prisma.adAccount.findFirst({ where: { currency: "AED" } });
  if (aed) {
    const sum = await prisma.spend.aggregate({ where: { adAccountId: aed.id }, _sum: { inrSpend: true, spend: true } });
    const pending = await prisma.spend.count({ where: { adAccountId: aed.id, inrRate: 0 } });
    console.log(
      `  AED account '${aed.name}': native ${sum._sum.spend} AED → INR total ₹${sum._sum.inrSpend} (still-pending native-only rows: ${pending})`
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
