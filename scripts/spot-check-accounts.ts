/**
 * Per-account 1-ad spot-check (the G1 1% rule, now for every accessible
 * account). For each AdAccount in the DB: pick the top-spend ad, fetch its
 * insights FRESH from the live Marketing API (same no-range rollup the pull
 * uses), and print the variance vs the stored row. Variance ≤ 1% per the G1
 * gate. Also re-verifies the G1 account's total (₹51,480.77-class, no
 * regression from the re-pull).
 *
 * Token read from .env, never printed.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

function env(key: string): string {
  const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  if (!line) return "";
  return line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, "").trim();
}

const INSIGHT_FIELDS = "date_start,date_stop,spend,impressions,reach,clicks,results";

async function main() {
  const token = env("META_ACCESS_TOKEN");
  const apiVersion = env("META_API_VERSION") || "v23.0";
  if (!token) {
    console.error("BLOCKED: META_ACCESS_TOKEN not in .env");
    process.exit(1);
  }
  const prisma = new PrismaClient();

  const accounts = await prisma.adAccount.findMany({ orderBy: { name: "asc" } });
  console.log("\n=== Per-account 1-ad spot-check (fresh live insights vs stored) ===");
  console.log("account | ad | stored day | stored spend | live spend | Δ% | verdict");
  let worst = 0;
  let allWithin = true;
  for (const acct of accounts) {
    // The top-spend ad in this account (by stored inrSpend, INR-normalized).
    const top = await prisma.spend.findFirst({
      where: { adAccountId: acct.id },
      orderBy: { inrSpend: "desc" },
    });
    if (!top) {
      console.log(`${acct.metaId} | (no spend rows) | — | 0 | — | — | EMPTY (0-spend account, or not pulled)`);
      continue;
    }
    // Fresh live GET for that ad (same rollup shape the pull stores).
    const url = `https://graph.facebook.com/${apiVersion}/${top.adMetaId}/insights?fields=${INSIGHT_FIELDS}&limit=100&access_token=${token}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`${acct.metaId} | ${top.adMetaId} | ${top.day} | ₹${top.inrSpend} | (live ${res.status}) | — | CHECK (live call failed)`);
      allWithin = false;
      continue;
    }
    const j: any = await res.json();
    const liveRow: any = (j.data ?? []).reduce((a: any, b: any) => (Number(b.spend ?? 0) > Number(a?.spend ?? 0) ? b : a), null);
    const liveSpend = Number(liveRow?.spend ?? 0);
    // Compare in the account's currency to avoid FX drift: stored `spend` is native.
    const nativeStored = Number(top.spend ?? 0);
    const variance =
      Math.max(nativeStored, liveSpend) > 0
        ? Math.abs(nativeStored - liveSpend) / Math.max(nativeStored, liveSpend) * 100
        : 0;
    const within = variance <= 1.0;
    if (variance > worst) worst = variance;
    if (!within) allWithin = false;
    console.log(
      `${acct.metaId} | ${top.adMetaId} | ${top.day} | ${nativeStored} ${acct.currency} | ${liveSpend} ${acct.currency} | ${variance.toFixed(3)}% | ${within ? "PASS ≤1%" : "FAIL >1%"}`
    );
  }
  console.log(`\nworst variance: ${worst.toFixed(3)}% | all accounts within 1%: ${allWithin}`);

  // G1 non-regression: the Upcurvv account total must still be ₹51,480.77-class.
  const g1 = await prisma.adAccount.findUnique({ where: { metaId: "act_4749960348632164" } });
  if (g1) {
    const sum = await prisma.spend.aggregate({ where: { adAccountId: g1.id }, _sum: { inrSpend: true, spend: true } });
    console.log(
      `G1 regression: act_4749960348632164 client=${g1.clientId} (expect cl_upcurvv) | inrSpend=₹${sum._sum.inrSpend ?? 0} (G1 verified total: ₹51480.77)`
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
